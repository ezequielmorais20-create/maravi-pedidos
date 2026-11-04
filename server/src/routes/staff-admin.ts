import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q, tx } from '../db';
import { parse, uuid } from '../lib/validation';
import { pixPublicStatus } from '../pix';
import * as auth from '../services/auth';
import { getSettings, listZones, saveZone, updateSettings } from '../services/settings';
import { actorOf, requirePermission } from './guards';

const zoneSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    neighborhoods: z.array(z.string().trim().min(2).max(80)).min(1).max(100),
    feeCents: z.number().int().min(0).max(100_000),
    etaMinMinutes: z.number().int().min(0).max(1440),
    etaMaxMinutes: z.number().int().min(0).max(1440),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .refine((z2) => z2.etaMaxMinutes >= z2.etaMinMinutes, { message: 'O prazo máximo precisa ser maior ou igual ao mínimo.', path: ['etaMaxMinutes'] });

export async function staffAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/staff/settings', async (req) => {
    requirePermission(req, 'settings.view');
    return { settings: await getSettings(pool), zones: await listZones(pool, false), pix: pixPublicStatus() };
  });

  app.put('/staff/settings', async (req) => {
    const u = requirePermission(req, 'settings.edit');
    const b = parse(
      z.object({
        loja: z.object({ nome: z.string().trim().min(2).max(120), endereco: z.string().trim().max(200), whatsapp: z.string().trim().max(30).default('') }).optional(),
        retiradaAtiva: z.boolean().optional(),
        entregaAtiva: z.boolean().optional(),
        retiradaPrazo: z.string().trim().min(3).max(200).optional(),
        reservaMinutos: z.number().int().min(5).max(120).optional(),
        descontoPixPercent: z.number().min(0).max(30).optional(),
        pagamentoLocalAtivo: z.boolean().optional(),
        reservaLocalHoras: z.number().int().min(1).max(168).optional(),
      }),
      req.body,
    );
    return { settings: await tx((c) => updateSettings(c, actorOf(req, u), b)) };
  });

  app.post('/staff/zones', async (req, reply) => {
    const u = requirePermission(req, 'settings.edit');
    return reply.code(201).send(await tx((c) => saveZone(c, actorOf(req, u), null, parse(zoneSchema, req.body))));
  });
  app.put('/staff/zones/:id', async (req) => {
    const u = requirePermission(req, 'settings.edit');
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    return tx((c) => saveZone(c, actorOf(req, u), id, parse(zoneSchema, req.body)));
  });

  // ---------------------------------------------------------------- equipe
  app.get('/staff/team', async (req) => {
    requirePermission(req, 'staff.manage');
    return { items: await auth.listStaff() };
  });
  app.post('/staff/team', async (req, reply) => {
    const u = requirePermission(req, 'staff.manage');
    const b = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(200),
        role: z.enum(['administrador', 'atendimento', 'estoque']),
        password: z.string().min(8).max(128),
      }),
      req.body,
    );
    return reply.code(201).send(await tx((c) => auth.createStaff(c, actorOf(req, u), b)));
  });
  app.put('/staff/team/:id', async (req) => {
    const u = requirePermission(req, 'staff.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(
      z.object({
        role: z.enum(['administrador', 'atendimento', 'estoque']).optional(),
        active: z.boolean().optional(),
        password: z.string().min(8).max(128).optional(),
      }),
      req.body,
    );
    await tx((c) => auth.updateStaff(c, actorOf(req, u), id, b));
    return { ok: true };
  });

  // -------------------------------------------------------------- auditoria
  app.get('/staff/audit', async (req) => {
    requirePermission(req, 'audit.view');
    const f = parse(
      z.object({
        entity: z.string().trim().max(40).optional(),
        action: z.string().trim().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    if (f.entity) {
      params.push(f.entity);
      where.push(`a.entity = $${params.length}`);
    }
    if (f.action) {
      params.push(`${f.action}%`);
      where.push(`a.action LIKE $${params.length}`);
    }
    params.push(f.limit);
    const items = await q(
      pool,
      `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at, a.actor_role, COALESCE(u.name, 'Sistema') AS actor_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    return { items };
  });
}
