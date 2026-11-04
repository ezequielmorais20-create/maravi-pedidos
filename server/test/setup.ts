// Executado antes de cada arquivo de teste: aponta tudo para o banco de TESTE e para o Pix simulado.
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

process.env.APP_ENV = 'desenvolvimento';
if (!process.env.TEST_DATABASE_URL) throw new Error('Defina TEST_DATABASE_URL para um banco descartável antes de rodar os testes.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.PIX_MODE = 'simulado';
process.env.PIX_WEBHOOK_SECRET = randomBytes(32).toString('hex');
process.env.SCRYPT_COST = '10';
process.env.APP_URL = 'http://localhost:3000';
process.env.CORS_ORIGINS = '';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'maravi-test-uploads');
process.env.WEB_DIST = path.join(os.tmpdir(), 'maravi-test-sem-web');

afterAll(async () => {
  const { closePool } = await import('../src/db.js');
  await closePool();
});
