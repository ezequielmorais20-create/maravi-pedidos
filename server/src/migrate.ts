import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { closePool, pool } from './db';

const DIR = path.resolve(__dirname, '../migrations');

/** Aplica, em ordem, as migrações .sql ainda não registradas. Cada arquivo roda em uma transação. */
export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const done: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // evita duas instâncias migrando ao mesmo tempo
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r: { filename: string }) => r.filename));
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        done.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return done;
}

if (require.main === module) {
  runMigrations()
    .then((d) => console.log(d.length ? `Migrações aplicadas: ${d.join(', ')}` : 'Banco já está atualizado.'))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
