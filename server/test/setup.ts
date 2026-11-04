// Executado antes de cada arquivo de teste: aponta tudo para o banco de TESTE e para o Pix simulado.
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

process.env.APP_ENV = 'desenvolvimento';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://maravi:maravi_dev@127.0.0.1:5432/maravi_test';
process.env.PIX_MODE = 'simulado';
process.env.PIX_WEBHOOK_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-ok';
process.env.SCRYPT_COST = '10';
process.env.APP_URL = 'http://localhost:3000';
process.env.CORS_ORIGINS = '';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'maravi-test-uploads');
process.env.WEB_DIST = path.join(os.tmpdir(), 'maravi-test-sem-web');

afterAll(async () => {
  const { closePool } = await import('../src/db.js');
  await closePool();
});
