import { buildApp } from './app';
import { config } from './config';
import { closePool } from './db';
import { runMigrations } from './migrate';
import { startExpiryJob, stopExpiryJob } from './services/expiry';

async function main(): Promise<void> {
  if (config.appEnv !== 'producao') {
    const applied = await runMigrations();
    if (applied.length) console.log(`[migrate] aplicadas: ${applied.join(', ')}`);
  }
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  if (config.pix.mode === 'simulado') {
    console.warn('\n  ⚠  PIX SIMULADO ATIVO — nenhum dinheiro real é cobrado ou recebido. Somente desenvolvimento/homologação.\n');
  } else if (config.pix.mode === 'real') {
    console.warn('\n  ⚠  PIX_MODE=real, mas a integração com o provedor NÃO foi homologada: cobranças reais permanecem desabilitadas.\n');
  } else {
    console.warn('\n  ⚠  Pix desabilitado (PIX_MODE=desabilitado): a loja exibe o catálogo, mas não gera cobranças.\n');
  }
  startExpiryJob();

  const stop = async (sig: string) => {
    console.log(`[${sig}] encerrando...`);
    stopExpiryJob();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
