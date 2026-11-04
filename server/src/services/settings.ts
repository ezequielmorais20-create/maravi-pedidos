import type { PoolClient } from 'pg';
import { q, q1, type Db } from '../db';
import { audit, type Actor } from '../lib/audit';
import { etaText, matchZone, type Zone } from '../lib/zones';
import { notFound } from '../lib/errors';

export interface StoreSettings {
  loja: { nome: string; endereco: string; whatsapp: string };
  retiradaAtiva: boolean;
  entregaAtiva: boolean;
  retiradaPrazo: string;
  reservaMinutos: number;
  descontoPixPercent: number;
  pagamentoLocalAtivo: boolean;
  reservaLocalHoras: number;
}

const KEYS = {
  loja: 'loja',
  retiradaAtiva: 'retirada_ativa',
  entregaAtiva: 'entrega_ativa',
  retiradaPrazo: 'retirada_prazo',
  reservaMinutos: 'reserva_minutos',
  descontoPixPercent: 'desconto_pix_percent',
  pagamentoLocalAtivo: 'pagamento_local_ativo',
  reservaLocalHoras: 'reserva_local_horas',
} as const;

const DEFAULTS: StoreSettings = {
  loja: { nome: 'MARAVI — Achadinhos e Variedades', endereco: 'Avenida do São Raimundo, São Luís – MA', whatsapp: '5598985066724' },
  retiradaAtiva: true,
  entregaAtiva: true,
  retiradaPrazo: 'Pronto para retirada em até 30 minutos após a confirmação do Pix.',
  reservaMinutos: 15,
  descontoPixPercent: 0,
  pagamentoLocalAtivo: true,
  reservaLocalHoras: 24,
};

export async function getSettings(db: Db): Promise<StoreSettings> {
  const rows = await q<{ key: string; value: unknown }>(db, `SELECT key, value FROM settings`);
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const pick = <T>(k: string, d: T): T => (m.has(k) ? (m.get(k) as T) : d);
  return {
    loja: { ...DEFAULTS.loja, ...(pick<Partial<StoreSettings['loja']>>(KEYS.loja, {}) as object) },
    retiradaAtiva: pick(KEYS.retiradaAtiva, DEFAULTS.retiradaAtiva),
    entregaAtiva: pick(KEYS.entregaAtiva, DEFAULTS.entregaAtiva),
    retiradaPrazo: pick(KEYS.retiradaPrazo, DEFAULTS.retiradaPrazo),
    reservaMinutos: pick(KEYS.reservaMinutos, DEFAULTS.reservaMinutos),
    descontoPixPercent: pick(KEYS.descontoPixPercent, DEFAULTS.descontoPixPercent),
    pagamentoLocalAtivo: pick(KEYS.pagamentoLocalAtivo, DEFAULTS.pagamentoLocalAtivo),
    reservaLocalHoras: pick(KEYS.reservaLocalHoras, DEFAULTS.reservaLocalHoras),
  };
}

export async function updateSettings(c: PoolClient, actor: Actor, patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const before = await getSettings(c);
  for (const [field, key] of Object.entries(KEYS)) {
    const v = (patch as Record<string, unknown>)[field];
    if (v === undefined) continue;
    await c.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(v), actor.id],
    );
  }
  const after = await getSettings(c);
  await audit(c, actor, 'configuracoes.atualizar', 'settings', null, { before, after });
  return after;
}

export async function listZones(db: Db, onlyActive = false): Promise<Zone[]> {
  return q<Zone>(db, `SELECT id, name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, active, sort_order FROM delivery_zones ${onlyActive ? 'WHERE active' : ''} ORDER BY sort_order, id`);
}

export interface ZoneInput {
  name: string;
  neighborhoods: string[];
  feeCents: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  active: boolean;
  sortOrder?: number;
}

export async function saveZone(c: PoolClient, actor: Actor, id: number | null, z: ZoneInput): Promise<Zone> {
  const vals = [z.name, z.neighborhoods, z.feeCents, z.etaMinMinutes, z.etaMaxMinutes, z.active, z.sortOrder ?? 0];
  let row: Zone | undefined;
  if (id === null) {
    row = await q1<Zone>(
      c,
      `INSERT INTO delivery_zones (name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, active, sort_order`,
      vals,
    );
  } else {
    row = await q1<Zone>(
      c,
      `UPDATE delivery_zones SET name=$1, neighborhoods=$2, fee_cents=$3, eta_min_minutes=$4, eta_max_minutes=$5, active=$6, sort_order=$7
        WHERE id=$8 RETURNING id, name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, active, sort_order`,
      [...vals, id],
    );
    if (!row) throw notFound('Zona de entrega não encontrada.');
  }
  await audit(c, actor, id === null ? 'entrega.zona_criada' : 'entrega.zona_atualizada', 'delivery_zone', row!.id, { ...z });
  return row!;
}

export { etaText, matchZone, type Zone };
