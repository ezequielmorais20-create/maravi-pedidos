import type { PoolClient } from 'pg';
import { config } from '../config';
import { pool, q, q1, tx, type Db } from '../db';
import { audit, type Actor } from '../lib/audit';
import { badRequest, conflict, notFound, pgCode, unauthorized } from '../lib/errors';
import { onlyDigits } from '../lib/text';
import { hashPassword, newToken, sha256Hex, validatePasswordStrength, verifyPassword } from '../lib/security';
import type { Role } from '../lib/permissions';

export interface SessionUser {
  id: string;
  role: Role;
  name: string;
  email: string;
  phone: string | null;
}

const STAFF_TTL_MS = 12 * 3600_000;
const CUSTOMER_TTL_MS = 14 * 24 * 3600_000;

let dummyHash: string | null = null; // iguala o tempo de resposta quando o e-mail não existe

export async function createSession(db: Db, user: { id: string; role: string }, meta: { ip?: string | null; userAgent?: string | null }) {
  const token = newToken();
  const ttl = user.role === 'cliente' ? CUSTOMER_TTL_MS : STAFF_TTL_MS;
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
    user.id,
    sha256Hex(token),
    new Date(Date.now() + ttl),
    meta.ip ?? null,
    (meta.userAgent ?? '').slice(0, 300),
  ]);
  return { token, maxAgeSeconds: Math.floor(ttl / 1000) };
}

export async function sessionUser(token: string): Promise<SessionUser | null> {
  const row = await q1<SessionUser & { active: boolean; lastSeenAt: Date; sessionId: string }>(
    pool,
    `SELECT u.id, u.role, u.name, u.email, u.phone, u.active, s.last_seen_at, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!row || !row.active) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.sessionId]);
  }
  return { id: row.id, role: row.role, name: row.name, email: row.email, phone: row.phone };
}

export async function destroySession(token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
}

export interface RegisterInput {
  name: string;
  email: string;
  phone?: string | null;
  password: string;
}

export async function register(input: RegisterInput, meta: { ip?: string | null; userAgent?: string | null }) {
  const weak = validatePasswordStrength(input.password);
  if (weak) throw badRequest(weak, undefined, 'senha_fraca');
  const hash = await hashPassword(input.password, config.scryptCost);
  try {
    const u = await q1<SessionUser>(
      pool,
      `INSERT INTO users (role, name, email, phone, password_hash) VALUES ('cliente',$1,$2,$3,$4) RETURNING id, role, name, email, phone`,
      [input.name.trim(), input.email.toLowerCase(), input.phone ? onlyDigits(input.phone) : null, hash],
    );
    const session = await createSession(pool, u!, meta);
    return { user: u!, session };
  } catch (e) {
    if (pgCode(e) === '23505') throw conflict('Este e-mail já está cadastrado. Tente entrar ou recuperar a senha.', 'email_em_uso');
    throw e;
  }
}

export async function login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const u = await q1<SessionUser & { passwordHash: string; active: boolean }>(
    pool,
    `SELECT id, role, name, email, phone, password_hash, active FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  let ok = false;
  if (u) {
    ok = await verifyPassword(password, u.passwordHash);
  } else {
    dummyHash ??= await hashPassword('senha-inexistente', config.scryptCost);
    await verifyPassword(password, dummyHash);
  }
  if (!u || !ok || !u.active) throw unauthorized('E-mail ou senha incorretos.');
  const session = await createSession(pool, u, meta);
  return { user: { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone } as SessionUser, session };
}

export async function sendMail(db: Db, to: string, subject: string, body: string): Promise<void> {
  // Sem SMTP configurado a mensagem fica na caixa de saída (outbox_emails). O envio real depende da
  // configuração da MARAVI (SMTP_URL) e de um transportador — ver docs/HOMOLOGACAO.md.
  await db.query(`INSERT INTO outbox_emails (to_email, subject, body) VALUES ($1,$2,$3)`, [to, subject, body]);
  if (!config.smtpUrl && config.appEnv === 'desenvolvimento') console.log(`[e-mail simulado] para ${to}: ${subject}\n${body}`);
}

/** Resposta idêntica exista o e-mail ou não (não revela cadastros). Em desenvolvimento devolve o link para facilitar testes. */
export async function forgotPassword(email: string): Promise<{ devLink?: string }> {
  const u = await q1<{ id: string; name: string; email: string }>(pool, `SELECT id, name, email FROM users WHERE email = $1 AND active`, [email.toLowerCase()]);
  if (!u) return {};
  const token = newToken();
  await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,now() + interval '1 hour')`, [u.id, sha256Hex(token)]);
  const link = `${config.appUrl}/conta/redefinir?token=${token}`;
  await sendMail(pool, u.email, 'Redefinição de senha — MARAVI', `Olá, ${u.name}!\n\nPara criar uma nova senha, acesse (válido por 1 hora):\n${link}\n\nSe você não pediu, ignore esta mensagem.`);
  return config.appEnv === 'desenvolvimento' ? { devLink: link } : {};
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const weak = validatePasswordStrength(newPassword);
  if (weak) throw badRequest(weak, undefined, 'senha_fraca');
  const hash = await hashPassword(newPassword, config.scryptCost);
  await tx(async (c) => {
    const r = await q1<{ id: string; userId: string }>(
      c,
      `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256Hex(token)],
    );
    if (!r) throw badRequest('Link inválido ou expirado. Peça um novo.', undefined, 'token_invalido');
    await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [r.userId, hash]);
    await c.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [r.id]);
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [r.userId]); // encerra todas as sessões
  });
}

export async function changePassword(userId: string, currentToken: string, current: string, next: string): Promise<void> {
  const weak = validatePasswordStrength(next);
  if (weak) throw badRequest(weak, undefined, 'senha_fraca');
  const u = await q1<{ passwordHash: string }>(pool, `SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw badRequest('Senha atual incorreta.', undefined, 'senha_atual_incorreta');
  const hash = await hashPassword(next, config.scryptCost);
  await tx(async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, hash]);
    await c.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, sha256Hex(currentToken)]);
  });
}

export async function updateProfile(userId: string, input: { name: string; phone?: string | null }): Promise<SessionUser> {
  const u = await q1<SessionUser>(pool, `UPDATE users SET name = $2, phone = $3, updated_at = now() WHERE id = $1 RETURNING id, role, name, email, phone`, [
    userId,
    input.name.trim(),
    input.phone ? onlyDigits(input.phone) : null,
  ]);
  if (!u) throw notFound();
  return u;
}

// ---------------------------------------------------------------------------
// Endereços (sempre filtrados pelo dono)
// ---------------------------------------------------------------------------
export interface AddressInput {
  label: string;
  recipient: string;
  phone?: string | null;
  cep?: string | null;
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  reference?: string | null;
  isDefault?: boolean;
}

export const listAddresses = (userId: string) =>
  q(pool, `SELECT id, label, recipient, phone, cep, street, number, complement, neighborhood, city, state, reference, is_default FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at`, [userId]);

async function clearDefault(c: PoolClient, userId: string) {
  await c.query(`UPDATE addresses SET is_default = false WHERE user_id = $1`, [userId]);
}

export async function saveAddress(userId: string, id: string | null, a: AddressInput) {
  return tx(async (c) => {
    const count = await q1<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM addresses WHERE user_id = $1`, [userId]);
    const makeDefault = a.isDefault || (count?.n ?? 0) === 0;
    if (makeDefault) await clearDefault(c, userId);
    const vals = [a.label, a.recipient, a.phone ? onlyDigits(a.phone) : null, a.cep ? onlyDigits(a.cep) : null, a.street, a.number, a.complement ?? null, a.neighborhood, a.reference ?? null, makeDefault];
    const row = id
      ? await q1(c, `UPDATE addresses SET label=$3, recipient=$4, phone=$5, cep=$6, street=$7, number=$8, complement=$9, neighborhood=$10, reference=$11, is_default=$12, updated_at=now()
                      WHERE id=$1 AND user_id=$2 RETURNING id, label, recipient, phone, cep, street, number, complement, neighborhood, city, state, reference, is_default`, [id, userId, ...vals])
      : await q1(c, `INSERT INTO addresses (user_id, label, recipient, phone, cep, street, number, complement, neighborhood, reference, is_default)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, label, recipient, phone, cep, street, number, complement, neighborhood, city, state, reference, is_default`, [userId, ...vals]);
    if (!row) throw notFound('Endereço não encontrado.');
    return row;
  });
}

export async function deleteAddress(userId: string, id: string): Promise<void> {
  const r = await pool.query(`DELETE FROM addresses WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (r.rowCount === 0) throw notFound('Endereço não encontrado.');
}

// ---------------------------------------------------------------------------
// Equipe (somente administrador)
// ---------------------------------------------------------------------------
export const listStaff = () =>
  q(pool, `SELECT id, name, email, role, active, created_at FROM users WHERE role <> 'cliente' ORDER BY name`);

export async function createStaff(c: PoolClient, actor: Actor, i: { name: string; email: string; role: Exclude<Role, 'cliente'>; password: string }) {
  const weak = validatePasswordStrength(i.password);
  if (weak) throw badRequest(weak, undefined, 'senha_fraca');
  try {
    const u = await q1<{ id: string }>(
      c,
      `INSERT INTO users (role, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [i.role, i.name.trim(), i.email.toLowerCase(), await hashPassword(i.password, config.scryptCost)],
    );
    await audit(c, actor, 'equipe.criar', 'user', u!.id, { email: i.email, role: i.role });
    return u!;
  } catch (e) {
    if (pgCode(e) === '23505') throw conflict('Este e-mail já está em uso.', 'email_em_uso');
    throw e;
  }
}

export async function updateStaff(c: PoolClient, actor: Actor, id: string, i: { role?: Exclude<Role, 'cliente'>; active?: boolean; password?: string }) {
  const u = await q1<{ id: string; role: string; active: boolean }>(c, `SELECT id, role, active FROM users WHERE id = $1 AND role <> 'cliente' FOR UPDATE`, [id]);
  if (!u) throw notFound('Usuário da equipe não encontrado.');
  if (id === actor.id && (i.active === false || (i.role && i.role !== u.role))) throw conflict('Você não pode desativar nem alterar o próprio perfil.', 'auto_alteracao');
  if (i.role) await c.query(`UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, [id, i.role]);
  if (i.active !== undefined) await c.query(`UPDATE users SET active = $2, updated_at = now() WHERE id = $1`, [id, i.active]);
  if (i.password) {
    const weak = validatePasswordStrength(i.password);
    if (weak) throw badRequest(weak, undefined, 'senha_fraca');
    await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [id, await hashPassword(i.password, config.scryptCost)]);
  }
  if (i.active === false || i.password || i.role) await c.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  await audit(c, actor, 'equipe.atualizar', 'user', id, { role: i.role, active: i.active, senhaRedefinida: Boolean(i.password) });
}
