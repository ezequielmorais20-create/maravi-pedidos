import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

const KEYLEN = 64;
const R = 8;
const P = 1;

/** Formato: scrypt$N$r$p$saltB64$hashB64 (parâmetros embutidos permitem aumentar o custo no futuro). */
export async function hashPassword(password: string, cost = 15): Promise<string> {
  const N = 2 ** cost;
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Token aleatório de 256 bits para cookies/links. O banco guarda apenas o sha256. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
export function hmacSha256Hex(secret: string, data: Buffer | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}
/** Comparação em tempo constante de strings hexadecimais. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 8) return 'A senha precisa ter ao menos 8 caracteres.';
  if (pw.length > 128) return 'A senha é longa demais.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  return null;
}
