import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config';
import { AppError, forbidden, pgCode } from './lib/errors';
import { zodToAppError } from './lib/validation';
import { COOKIE_NAME } from './routes/guards';
import { customerRoutes } from './routes/customer';
import { publicRoutes, webhookRoutes } from './routes/public';
import { staffAdminRoutes } from './routes/staff-admin';
import { staffCatalogRoutes } from './routes/staff-catalog';
import { staffOrderRoutes } from './routes/staff-orders';
import { sessionUser } from './services/auth';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(opts: { logger?: boolean; rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.appEnv === 'desenvolvimento' ? 'info' : 'warn', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  // `rateLimit: false` existe só para os testes automatizados (muitos logins do mesmo IP).
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', ...(opts.rateLimit === false ? { allowList: () => true } : {}) });
  await app.register(multipart);

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  // Sessão: cookie httpOnly com token aleatório; o banco guarda só o hash.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      const u = await sessionUser(token);
      if (u) {
        req.user = u;
        req.sessionToken = token;
      }
    }
  });

  // CSRF: SameSite=Lax no cookie + verificação de Origin em toda requisição que altera dados.
  app.addHook('onRequest', async (req) => {
    if (!UNSAFE.has(req.method) || !req.url.startsWith('/api/') || req.url.startsWith('/api/webhooks/')) return;
    const origin = req.headers.origin;
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) throw forbidden('Origem da requisição não permitida.');
    } else if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw forbidden('Origem da requisição não permitida.');
    }
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const e = zodToAppError(err);
      return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
    }
    const code = pgCode(err);
    if (code === '22P02') return reply.code(400).send({ error: { code: 'dados_invalidos', message: 'Identificador inválido.' } });
    if (code === '23505') return reply.code(409).send({ error: { code: 'conflito', message: 'Este registro já existe.' } });
    if (code === '23514' || code === '23503') return reply.code(409).send({ error: { code: 'violacao_de_regra', message: 'A operação viola uma regra de integridade dos dados.' } });
    const status = (err as FastifyError).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: 'muitas_requisicoes', message: 'Muitas tentativas. Aguarde um instante e tente de novo.' } });
    if (status === 413) return reply.code(413).send({ error: { code: 'arquivo_grande', message: 'O arquivo enviado é grande demais.' } });
    if (status && status < 500) return reply.code(status).send({ error: { code: 'requisicao_invalida', message: 'Requisição inválida.' } });
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: { code: 'erro_interno', message: 'Ocorreu um erro inesperado. Tente novamente.' } });
  });

  // ------------------------------------------------------------------ API
  await app.register(publicRoutes, { prefix: '/api' });
  await app.register(webhookRoutes, { prefix: '/api' });
  await app.register(customerRoutes, { prefix: '/api' });
  await app.register(staffOrderRoutes, { prefix: '/api' });
  await app.register(staffCatalogRoutes, { prefix: '/api' });
  await app.register(staffAdminRoutes, { prefix: '/api' });

  // ------------------------------------------------- arquivos estáticos / PWA
  const hasWeb = existsSync(path.join(config.webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      setHeaders(reply, filePath) {
        const base = path.basename(filePath);
        if (base === 'index.html' || base === 'sw.js' || base === 'manifest.webmanifest') reply.header('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  mkdirSync(config.uploadDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.uploadDir,
    prefix: '/uploads/',
    decorateReply: !hasWeb,
    setHeaders(reply) {
      // Imagens enviadas nunca executam script, mesmo se abertas diretamente.
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'public, max-age=86400');
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/') || !hasWeb || req.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'nao_encontrado', message: 'Recurso não encontrado.' } });
    }
    return reply.sendFile('index.html'); // SPA: rotas do React (/catalogo, /painel/...)
  });

  return app;
}
