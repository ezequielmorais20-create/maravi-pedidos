/**
 * Cria um usuário de qualquer perfil: administrador, atendimento, estoque ou cliente.
 * Uso: USER_NAME="Maria" USER_EMAIL=maria@dominio.com USER_ROLE=cliente USER_PASSWORD='senha-forte1' npm run create-user -w server
 * (a senha vem do ambiente para não aparecer na lista de processos). Mínimo 8 caracteres, com letras e números.
 */
import { closePool, pool } from './db';
import { hashPassword, validatePasswordStrength } from './lib/security';
import { config } from './config';

const ROLES = ['administrador', 'atendimento', 'estoque', 'cliente'];

async function main(): Promise<void> {
  const { USER_NAME: name, USER_EMAIL: email, USER_ROLE: role = 'cliente', USER_PASSWORD: password } = process.env;
  if (!name || !email || !password) throw new Error('Defina USER_NAME, USER_EMAIL, USER_PASSWORD (e USER_ROLE: ' + ROLES.join(' | ') + ').');
  if (!ROLES.includes(role)) throw new Error('USER_ROLE inválido. Use: ' + ROLES.join(', '));
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const hash = await hashPassword(password, config.scryptCost);
  const r = await pool.query(
    `INSERT INTO users (role, name, email, password_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, name = EXCLUDED.name, active = true, updated_at = now()
     RETURNING id`,
    [role, name.trim(), email.toLowerCase(), hash],
  );
  console.log(`Usuário ${role} pronto: ${email} (${r.rows[0].id})`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => closePool());
