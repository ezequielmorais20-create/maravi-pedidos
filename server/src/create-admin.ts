/**
 * Cria o primeiro Administrador (o seed é bloqueado em produção).
 * Uso: ADMIN_NAME="Fulana" ADMIN_EMAIL=fulana@dominio.com ADMIN_PASSWORD='senha-forte' npm run create-admin
 * A senha vem do ambiente (não de argumento) para não ficar no histórico do shell em texto visível na lista de processos.
 */
import { closePool, tx } from './db';
import { SYSTEM_ACTOR } from './lib/audit';
import { createStaff } from './services/auth';

async function main(): Promise<void> {
  const { ADMIN_NAME: name, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!name || !email || !password) throw new Error('Defina ADMIN_NAME, ADMIN_EMAIL e ADMIN_PASSWORD.');
  const u = await tx((c) => createStaff(c, SYSTEM_ACTOR, { name, email, role: 'administrador', password }));
  console.log(`Administrador criado: ${email} (${u.id})`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => closePool());
