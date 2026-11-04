import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { pool, tx } from '../db';
import { badRequest, forbidden } from '../lib/errors';
import { can } from '../lib/permissions';
import { centsInt, parse, uploadPath, uuid } from '../lib/validation';
import * as catalog from '../services/catalog';
import * as stock from '../services/stock';
import { actorOf, requireUser, requirePermission } from './guards';

const skuSchema = z.object({
  id: uuid.optional(),
  sku: z.string().trim().min(1).max(40),
  variantName: z.string().trim().min(1).max(80).default('Único'),
  priceCents: centsInt.refine((v) => v > 0, 'O preço precisa ser maior que zero.'),
  costCents: centsInt.optional(),
  minStock: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
  imageUrl: uploadPath.optional().nullable(),
  initialStock: z.number().int().min(0).max(100000).optional(),
});
const productSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).default(''),
  categoryId: z.number().int().positive(),
  status: z.enum(['rascunho', 'publicado', 'arquivado']).default('rascunho'),
  images: z.array(uploadPath).max(8).default([]),
  skus: z.array(skuSchema).min(1).max(40),
});

const qty = z.number().int().min(1).max(100000);
const reason = z.string().trim().min(3).max(300);

/** Tipos de imagem aceitos, identificados pelos bytes iniciais (nunca pelo nome ou Content-Type enviado). */
function sniffImage(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export async function staffCatalogRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------- categorias
  app.get('/staff/categories', async (req) => {
    requirePermission(req, 'products.view');
    const { rows } = await pool.query(`SELECT id, name, slug, active FROM categories ORDER BY sort_order, name`);
    return { items: rows };
  });
  app.post('/staff/categories', async (req, reply) => {
    const u = requirePermission(req, 'products.edit');
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
    return reply.code(201).send(await tx((c) => catalog.createCategory(c, actorOf(req, u), name)));
  });

  // ------------------------------------------------------------- produtos
  app.get('/staff/products', async (req) => {
    const u = requirePermission(req, 'products.view');
    const f = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        status: z.enum(['rascunho', 'publicado', 'arquivado']).optional(),
        categoryId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    return { items: await catalog.listProductsStaff(pool, f, can(u.role, 'products.cost')) };
  });

  app.get('/staff/products/:id', async (req) => {
    const u = requirePermission(req, 'products.view');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return catalog.getProductStaff(pool, id, { showCost: can(u.role, 'products.cost'), showPriceHistory: can(u.role, 'products.price') });
  });

  app.post('/staff/products', async (req, reply) => {
    const u = requirePermission(req, 'products.edit');
    if (!can(u.role, 'products.price')) throw forbidden('Seu perfil não pode definir preços; peça a um administrador.');
    const input = parse(productSchema, req.body);
    if (!can(u.role, 'products.cost')) input.skus.forEach((s) => (s.costCents = 0));
    return reply.code(201).send(await tx((c) => catalog.createProduct(c, actorOf(req, u), input)));
  });

  app.put('/staff/products/:id', async (req) => {
    const u = requirePermission(req, 'products.edit');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const input = parse(productSchema, req.body);
    await tx((c) => catalog.updateProduct(c, actorOf(req, u), id, input, { price: can(u.role, 'products.price'), cost: can(u.role, 'products.cost') }));
    return catalog.getProductStaff(pool, id, { showCost: can(u.role, 'products.cost'), showPriceHistory: can(u.role, 'products.price') });
  });

  app.post('/staff/products/:id/status', async (req) => {
    const u = requirePermission(req, 'products.edit');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { status } = parse(z.object({ status: z.enum(['rascunho', 'publicado', 'arquivado']) }), req.body);
    await tx((c) => catalog.setProductStatus(c, actorOf(req, u), id, status));
    return { ok: true };
  });

  app.delete('/staff/products/:id', async (req) => {
    const u = requirePermission(req, 'products.price'); // somente administrador
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx((c) => catalog.deleteProduct(c, actorOf(req, u), id));
    return { ok: true };
  });

  // -------------------------------------------------------------- uploads
  app.post('/staff/uploads', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = requireUser(req);
    if (!can(u.role, 'products.edit') && !can(u.role, 'stock.damage')) throw forbidden();
    const file = await req.file({ limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie um arquivo de imagem.', undefined, 'arquivo_ausente');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest('A imagem passa de 4 MB.', undefined, 'arquivo_grande');
    const ext = sniffImage(buf);
    if (!ext) throw badRequest('Formato não aceito. Use PNG, JPG ou WEBP.', undefined, 'formato_invalido');
    const name = `${randomBytes(12).toString('hex')}.${ext}`;
    await mkdir(config.uploadDir, { recursive: true });
    await writeFile(path.join(config.uploadDir, name), buf, { flag: 'wx' });
    return reply.code(201).send({ url: `/uploads/${name}` });
  });

  // -------------------------------------------------------------- estoque
  app.get('/staff/stock', async (req) => {
    requirePermission(req, 'stock.view');
    const f = parse(z.object({ q: z.string().trim().max(100).optional(), low: z.enum(['true', 'false']).optional(), damaged: z.enum(['true', 'false']).optional() }), req.query);
    return { items: await stock.listStock(pool, { q: f.q || undefined, low: f.low === 'true', damaged: f.damaged === 'true' }) };
  });

  app.get('/staff/stock/:skuId/movements', async (req) => {
    requirePermission(req, 'stock.view');
    const { skuId } = parse(z.object({ skuId: uuid }), req.params);
    return { items: await stock.listMovements(pool, skuId) };
  });

  app.post('/staff/stock/entry', async (req, reply) => {
    const u = requirePermission(req, 'stock.move');
    const b = parse(z.object({ skuId: uuid, quantity: qty, reason: reason.default('Entrada de mercadoria') }), req.body);
    return reply.code(201).send(await tx((c) => stock.entry(c, actorOf(req, u), b)));
  });

  app.post('/staff/stock/adjust', async (req, reply) => {
    const u = requirePermission(req, 'stock.move');
    const b = parse(z.object({ skuId: uuid, delta: z.number().int().min(-100000).max(100000), reason }), req.body);
    return reply.code(201).send(await tx((c) => stock.adjust(c, actorOf(req, u), b)));
  });

  app.post('/staff/stock/damage', async (req, reply) => {
    const u = requirePermission(req, 'stock.damage');
    const b = parse(z.object({ skuId: uuid, quantity: qty, reason, orderId: uuid.optional().nullable(), photoUrl: uploadPath.optional().nullable() }), req.body);
    return reply.code(201).send(await tx((c) => stock.registerDamage(c, actorOf(req, u), b)));
  });

  app.post('/staff/stock/discard', async (req, reply) => {
    const u = requirePermission(req, 'stock.damage');
    const b = parse(z.object({ skuId: uuid, quantity: qty, reason, photoUrl: uploadPath.optional().nullable() }), req.body);
    return reply.code(201).send(await tx((c) => stock.discard(c, actorOf(req, u), b)));
  });

  app.post('/staff/stock/recover', async (req, reply) => {
    const u = requirePermission(req, 'stock.damage');
    const b = parse(z.object({ skuId: uuid, quantity: qty, reason }), req.body);
    return reply.code(201).send(await tx((c) => stock.recover(c, actorOf(req, u), b)));
  });

  app.get('/staff/exceptions', async (req) => {
    requirePermission(req, 'stock.view');
    const { status } = parse(z.object({ status: z.enum(['aberta', 'todas']).default('aberta') }), req.query);
    return { items: await stock.listExceptions(pool, status) };
  });

  app.post('/staff/exceptions/:id/resolve', async (req) => {
    const u = requirePermission(req, 'stock.resolve');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { note } = parse(z.object({ note: reason }), req.body);
    await tx((c) => stock.resolveException(c, actorOf(req, u), id, note));
    return { ok: true };
  });
}
