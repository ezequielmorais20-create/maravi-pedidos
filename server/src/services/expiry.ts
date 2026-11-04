import type { PoolClient } from 'pg';
import { pool, q, tx } from '../db';
import { audit, SYSTEM_ACTOR } from '../lib/audit';
import { getPixProvider } from '../pix';
import { reconcileCharge } from './payments';
import * as stock from './stock';
import { orderEvent, type StockLine } from './stock';

export interface ExpiryResult {
  expired: number;
  confirmed: number;
  skipped: number;
}

/**
 * Libera reservas vencidas. Regra de ouro: CONCILIAR ANTES DE LIBERAR.
 * Para cada pedido vencido consultamos o provedor; se a cobrança já foi paga, confirmamos o pedido
 * normalmente (a reserva ainda existe). Se o provedor não responder, NÃO liberamos — tentamos no próximo ciclo.
 * `now` é injetável para testes.
 */
export async function expireDueOrders(now: Date = new Date()): Promise<ExpiryResult> {
  const due = await q<{ orderId: string; providerChargeId: string | null }>(
    pool,
    `SELECT o.id AS order_id, c.provider_charge_id
       FROM orders o LEFT JOIN pix_charges c ON c.order_id = o.id AND c.status = 'ativa'
      WHERE o.payment_status = 'pendente' AND o.reservation_expires_at <= $1
      ORDER BY o.reservation_expires_at
      LIMIT 200`,
    [now],
  );
  const out: ExpiryResult = { expired: 0, confirmed: 0, skipped: 0 };
  for (const d of due) {
    try {
      const provider = d.providerChargeId ? getPixProvider() : null; // pedidos de pagamento local não têm cobrança
      if (d.providerChargeId && provider) {
        const r = await reconcileCharge(provider, { providerChargeId: d.providerChargeId });
        if (r === 'paga') {
          out.confirmed++;
          continue;
        }
      }
      const released = await tx((c) => expireOrderTx(c, d.orderId, now));
      if (released) {
        out.expired++;
        if (d.providerChargeId && provider) await provider.cancelCharge(d.providerChargeId).catch(() => undefined);
      }
    } catch (err) {
      out.skipped++;
      console.error(`[expiry] não foi possível conciliar/expirar o pedido ${d.orderId}:`, (err as Error).message);
    }
  }
  return out;
}

async function expireOrderTx(c: PoolClient, orderId: string, now: Date): Promise<boolean> {
  const res = await c.query(
    `SELECT id, number, payment_status, reservation_status, reservation_expires_at, payment_method FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const o = res.rows[0] as { id: string; number: number; payment_status: string; reservation_status: string; reservation_expires_at: Date; payment_method: string } | undefined;
  // Revalida sob o bloqueio: o pedido pode ter sido pago/cancelado enquanto conciliávamos.
  if (!o || o.payment_status !== 'pendente' || o.reservation_status !== 'ativa' || o.reservation_expires_at > now) return false;
  const items = await q<StockLine>(c, `SELECT sku_id, quantity FROM order_items WHERE order_id = $1 ORDER BY sku_id`, [orderId]);
  await stock.releaseReservation(c, { id: o.id, number: o.number }, items, `Reserva vencida do pedido #${o.number}`, null);
  await stock.cancelOpenExceptions(c, orderId, 'Reserva vencida');
  await c.query(`UPDATE pix_charges SET status = 'expirada' WHERE order_id = $1 AND status = 'ativa'`, [orderId]);
  await c.query(
    `UPDATE orders SET payment_status = 'expirado', fulfillment_status = 'cancelado', reservation_status = 'liberada', updated_at = now() WHERE id = $1`,
    [orderId],
  );
  await orderEvent(c, orderId, 'expirado', SYSTEM_ACTOR, o.payment_method === 'local' ? 'O prazo para pagamento venceu e a reserva dos itens foi liberada.' : 'O prazo do Pix venceu e a reserva dos itens foi liberada.', true, 'aguardando_pagamento', 'cancelado');
  await audit(c, SYSTEM_ACTOR, 'pedido.expirado', 'order', orderId, { number: o.number });
  return true;
}

let timer: NodeJS.Timeout | null = null;

export function startExpiryJob(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    expireDueOrders().catch((e: Error) => {
      // Pix desabilitado / real não homologado: não há o que expirar via provedor.
      if (!/indispon|homolog/i.test(e.message)) console.error('[expiry]', e.message);
    });
  }, intervalMs);
  timer.unref();
}

export function stopExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
