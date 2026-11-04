import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Carrega .env (raiz do repositório ou pasta server) sem sobrescrever variáveis já definidas. */
function loadDotenv(): void {
  for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')]) {
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p);
      } catch {
        /* arquivo ilegível: segue com o ambiente atual */
      }
      return;
    }
  }
}

const schema = z.object({
  APP_ENV: z.enum(['desenvolvimento', 'homologacao', 'producao']).default('desenvolvimento'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Origens extras aceitas em requisições que alteram dados (ex.: Vite em dev), separadas por vírgula. */
  CORS_ORIGINS: z.string().default(''),
  /** true quando o app roda atrás de proxy reverso (usa X-Forwarded-For para o IP real). */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  PIX_MODE: z.enum(['desabilitado', 'simulado', 'real']).default('desabilitado'),
  PIX_WEBHOOK_SECRET: z.string().min(32, 'PIX_WEBHOOK_SECRET precisa ter ao menos 32 caracteres'),
  PIX_PROVIDER: z.string().default(''),
  PIX_PROVIDER_BASE_URL: z.string().default(''),
  PIX_PROVIDER_CLIENT_ID: z.string().default(''),
  PIX_PROVIDER_CLIENT_SECRET: z.string().default(''),
  PIX_RECEIVER_KEY: z.string().default(''),
  PIX_RECEIVER_NAME: z.string().default('MARAVI'),
  PIX_RECEIVER_CITY: z.string().default('SAO LUIS'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('MARAVI <nao-responder@maravi.example>'),
  /** Custo do scrypt (N = 2^SCRYPT_COST). Testes usam valor baixo. */
  SCRYPT_COST: z.coerce.number().int().min(10).max(18).default(15),
  UPLOAD_DIR: z.string().default(path.resolve(__dirname, '../uploads')),
  WEB_DIST: z.string().default(path.resolve(__dirname, '../../web/dist')),
  SEED_PASSWORD: z.string().default(''),
});

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig(env: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${msg}`);
  }
  const e = parsed.data;

  if (e.APP_ENV === 'producao') {
    if (e.PIX_MODE === 'simulado') {
      throw new Error('PIX_MODE=simulado é proibido com APP_ENV=producao. Use desabilitado até homologar o provedor.');
    }
    if (e.PIX_WEBHOOK_SECRET.startsWith('troque-')) {
      throw new Error('Defina um PIX_WEBHOOK_SECRET real em produção.');
    }
  }

  const realConfigured = Boolean(
    e.PIX_PROVIDER && e.PIX_PROVIDER_BASE_URL && e.PIX_PROVIDER_CLIENT_ID && e.PIX_PROVIDER_CLIENT_SECRET && e.PIX_RECEIVER_KEY,
  );

  return {
    appEnv: e.APP_ENV,
    isProd: e.APP_ENV === 'producao',
    trustProxy: e.TRUST_PROXY === 'true',
    port: e.PORT,
    host: e.HOST,
    appUrl: e.APP_URL,
    allowedOrigins: [new URL(e.APP_URL).origin, ...e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)],
    databaseUrl: e.DATABASE_URL,
    pix: {
      mode: e.PIX_MODE,
      webhookSecret: e.PIX_WEBHOOK_SECRET,
      provider: e.PIX_PROVIDER,
      realConfigured,
      receiverKey: e.PIX_RECEIVER_KEY,
      receiverName: e.PIX_RECEIVER_NAME,
      receiverCity: e.PIX_RECEIVER_CITY,
    },
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
    scryptCost: e.SCRYPT_COST,
    uploadDir: e.UPLOAD_DIR,
    webDist: e.WEB_DIST,
    seedPassword: e.SEED_PASSWORD,
  };
}

loadDotenv();
// Carrega o .env da raiz do projeto, se existir (não sobrescreve variáveis já definidas no ambiente).
try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
} catch {
  /* sem .env: usa apenas as variáveis do ambiente */
}

export const config = buildConfig(process.env);
export { buildConfig };
