import type { Db } from '../db';

export interface Actor {
  id: string | null; // null = sistema (job, webhook)
  role: string | null;
  name: string;
  ip?: string | null;
}
export const SYSTEM_ACTOR: Actor = { id: null, role: null, name: 'Sistema' };

/** Registra operação sensível na trilha de auditoria (tabela somente de inserção). */
export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | number | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actor.id, actor.role, action, entity, entityId === null ? null : String(entityId), JSON.stringify(details), actor.ip ?? null],
  );
}
