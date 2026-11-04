import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { SessionUser } from '../services/auth';
import type { Actor } from '../lib/audit';
import { forbidden, unauthorized } from '../lib/errors';
import { can, type Permission } from '../lib/permissions';
import type { StaffView } from '../services/orders';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
  }
}

export const COOKIE_NAME = 'maravi_session';

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    path: '/',
    maxAge: maxAgeSeconds,
  });
}
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Área da cliente: somente perfil "cliente". */
export function requireCustomer(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'cliente') throw forbidden('Esta área é exclusiva para clientes.');
  return u;
}

/** Permissão validada no servidor, a cada requisição. */
export function requirePermission(req: FastifyRequest, perm: Permission): SessionUser {
  const u = requireUser(req);
  if (!can(u.role, perm)) throw forbidden();
  return u;
}

export function actorOf(req: FastifyRequest, u: SessionUser): Actor {
  return { id: u.id, role: u.role, name: u.name, ip: req.ip };
}

export function staffViewOf(u: SessionUser): StaffView {
  return { pii: can(u.role, 'customers.pii'), totals: can(u.role, 'orders.totals') };
}
