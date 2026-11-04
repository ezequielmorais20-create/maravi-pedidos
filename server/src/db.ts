import pg from 'pg';
import { config } from './config';

// bigint (int8) e count(*) chegam como string por padrão; nossos volumes cabem em Number.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;
export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
pool.on('error', (err) => console.error('[pg] erro em conexão ociosa:', err.message));

function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
export function camelize<T = any>(v: unknown): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (Array.isArray(v)) return v.map((x) => camelize(x)) as T;
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[camelKey(k)] = camelize(val);
    return out as T;
  }
  return v as T;
}

/** Executa SQL parametrizado e devolve linhas com chaves em camelCase. */
export async function q<T = Row>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(text, params as any[]);
  return res.rows.map((r) => camelize<T>(r));
}
export async function q1<T = Row>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(db, text, params))[0];
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/** Transação com repetição automática em deadlock/serialização. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexão já inválida */
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && i < attempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
