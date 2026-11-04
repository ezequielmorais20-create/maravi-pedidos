import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q1 } from '../db';
import { can } from '../lib/permissions';
import { notFound } from '../lib/errors';
import { parse, uuid } from '../lib/validation';
import { isPixSimulated } from '../pix';
import * as auth from '../services/auth';
import * as orders from '../services/orders';
import { actorOf, requireCustomer, requireUser } from './guards';
import { userPayload } from './public';

const cartSchema = z.object({
  items: z.array(z.object({ skuId: uuid, quantity: z.number().int().min(1).max(99) })).min(1).max(50),
  deliveryMode: z.enum(['retirada', 'entrega']),
  addressId: uuid.optional().nullable(),
  paymentMethod: z.enum(['pix', 'local']).default('local'),
});

const addressSchema = z.object({
  label: z.string().trim().min(1).max(40).default('Casa'),
  recipient: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional().nullable(),
  cep: z.string().trim().max(12).optional().nullable(),
  street: z.string().trim().min(2).max(160),
  number: z.string().trim().min(1).max(20),
  complement: z.string().trim().max(120).optional().nullable(),
  neighborhood: z.string().trim().min(2).max(100),
  reference: z.string().trim().max(200).optional().nullable(),
  isDefault: z.boolean().optional(),
});

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // ----------------------------------------------------------- perfil
  app.patch('/me', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional().nullable() }), req.body);
    return { user: userPayload(await auth.updateProfile(u.id, b)) };
  });

  app.post('/me/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ current: z.string().min(1).max(128), next: z.string().min(8).max(128) }), req.body);
    await auth.changePassword(u.id, req.sessionToken!, b.current, b.next);
    return { ok: true };
  });

  // -------------------------------------------------------- endereços
  app.get('/me/addresses', async (req) => ({ items: await auth.listAddresses(requireCustomer(req).id) }));
  app.post('/me/addresses', async (req, reply) => {
    const u = requireCustomer(req);
    return reply.code(201).send(await auth.saveAddress(u.id, null, parse(addressSchema, req.body)));
  });
  app.put('/me/addresses/:id', async (req) => {
    const u = requireCustomer(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return auth.saveAddress(u.id, id, parse(addressSchema, req.body));
  });
  app.delete('/me/addresses/:id', async (req) => {
    const u = requireCustomer(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await auth.deleteAddress(u.id, id);
    return { ok: true };
  });

  // --------------------------------------------------------- compra
  app.post('/checkout/quote', async (req) => {
    const u = requireCustomer(req);
    return orders.quote(u.id, parse(cartSchema, req.body));
  });

  app.post('/orders', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = requireCustomer(req);
    const body = parse(cartSchema.extend({ idempotencyKey: z.string().trim().min(8).max(100).optional() }), req.body);
    const headerKey = req.headers['idempotency-key'];
    const key = (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? body.idempotencyKey;
    if (!key || key.length < 8 || key.length > 100) {
      return reply.code(400).send({ error: { code: 'idempotency_key', message: 'Envie uma chave de idempotência (cabeçalho Idempotency-Key).' } });
    }
    const order = await orders.createCheckout({ id: u.id, name: u.name, email: u.email, phone: u.phone }, { ...body, idempotencyKey: key });
    return reply.code(201).send(order);
  });

  app.get('/orders', async (req) => ({ items: await orders.listCustomerOrders(requireCustomer(req).id) }));

  // O filtro por dono está dentro do serviço: pedido de outra cliente responde 404, não 403.
  app.get('/orders/:id', async (req) => {
    const u = requireCustomer(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return orders.getCustomerOrder(u.id, id);
  });

  app.post('/orders/:id/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireCustomer(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return orders.refreshCustomerPayment(u.id, id);
  });

  app.post('/orders/:id/cancel', async (req) => {
    const u = requireCustomer(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await orders.cancelUnpaidOrder(actorOf(req, u), id, u.id);
    return orders.getCustomerOrder(u.id, id);
  });

  // -------------------------------------------- simulação (somente dev/homologação)
  if (isPixSimulated()) {
    app.post('/dev/orders/:id/simulate-payment', async (req) => {
      const u = requireUser(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const o = await q1<{ userId: string }>(pool, `SELECT user_id FROM orders WHERE id = $1`, [id]);
      if (!o || (o.userId !== u.id && !can(u.role, 'orders.review'))) throw notFound('Pedido não encontrado.');
      const r = await orders.simulatePixPayment(id);
      return { simulated: true, result: r.result };
    });
  }
}
