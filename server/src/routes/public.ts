import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db';
import { permissionsOf } from '../lib/permissions';
import { parse, uuid } from '../lib/validation';
import { pixPublicStatus } from '../pix';
import * as auth from '../services/auth';
import * as catalog from '../services/catalog';
import { handleWebhook } from '../services/payments';
import { getSettings, listZones } from '../services/settings';
import { clearSessionCookie, setSessionCookie } from './guards';

const AUTH_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).optional().nullable(),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(128) });

export function userPayload(u: auth.SessionUser) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, permissions: permissionsOf(u.role) };
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, env: config.appEnv };
  });

  app.get('/config', async () => {
    const [s, zones] = await Promise.all([getSettings(pool), listZones(pool, true)]);
    return {
      loja: s.loja,
      retiradaAtiva: s.retiradaAtiva,
      entregaAtiva: s.entregaAtiva,
      retiradaPrazo: s.retiradaPrazo,
      reservaMinutos: s.reservaMinutos,
      descontoPixPercent: s.descontoPixPercent,
      pagamentoLocalAtivo: s.pagamentoLocalAtivo,
      reservaLocalHoras: s.reservaLocalHoras,
      zones: zones.map((z) => ({ id: z.id, name: z.name, feeCents: z.feeCents, etaMinMinutes: z.etaMinMinutes, etaMaxMinutes: z.etaMaxMinutes, neighborhoods: z.neighborhoods })),
      pix: pixPublicStatus(),
      appEnv: config.appEnv,
      timezone: 'America/Fortaleza',
    };
  });

  // ------------------------------------------------------------- catálogo
  app.get('/catalog/categories', async () => ({ items: await catalog.listCategories(pool) }));

  app.get('/catalog/products', async (req) => {
    const f = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        category: z.string().trim().max(80).optional(),
        inStock: z.enum(['true', 'false']).optional(),
        minPrice: z.coerce.number().int().min(0).optional(),
        maxPrice: z.coerce.number().int().min(0).optional(),
        sort: z.enum(['novos', 'menor_preco', 'maior_preco', 'nome']).optional(),
        page: z.coerce.number().int().min(1).max(1000).optional(),
      }),
      req.query,
    );
    return catalog.listPublicProducts(pool, {
      q: f.q || undefined,
      category: f.category || undefined,
      inStock: f.inStock === 'true',
      minPriceCents: f.minPrice,
      maxPriceCents: f.maxPrice,
      sort: f.sort,
      page: f.page,
    });
  });

  app.get('/catalog/products/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return catalog.getPublicProduct(pool, id);
  });

  // --------------------------------------------------------- autenticação
  app.post('/auth/register', AUTH_LIMIT, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const { user, session } = await auth.register(body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, session.token, session.maxAgeSeconds);
    return reply.code(201).send({ user: userPayload(user) });
  });

  app.post('/auth/login', AUTH_LIMIT, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const { user, session } = await auth.login(body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, session.token, session.maxAgeSeconds);
    return { user: userPayload(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionToken) await auth.destroySession(req.sessionToken);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: req.user ? userPayload(req.user) : null }));

  app.post('/auth/forgot', AUTH_LIMIT, async (req) => {
    const { email } = parse(z.object({ email: z.string().trim().email().max(200) }), req.body);
    const r = await auth.forgotPassword(email);
    // Resposta sempre igual: não revela se o e-mail está cadastrado.
    return { ok: true, message: 'Se o e-mail estiver cadastrado, enviaremos as instruções.', ...r };
  });

  app.post('/auth/reset', AUTH_LIMIT, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(128) }), req.body);
    await auth.resetPassword(b.token, b.password);
    return { ok: true };
  });
}

/**
 * Webhook do provedor Pix. Escopo próprio para receber o corpo BRUTO (a assinatura HMAC é calculada
 * sobre os bytes exatos enviados). Sem cookie/CSRF: a autenticidade vem da assinatura.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post('/webhooks/pix', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const raw = req.body as Buffer;
    const { result } = await handleWebhook(raw, req.headers);
    return { ok: true, result };
  });
}
