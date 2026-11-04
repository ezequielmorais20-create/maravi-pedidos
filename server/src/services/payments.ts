import type { PoolClient } from 'pg';
import { q, q1, tx } from '../db';
import { audit, SYSTEM_ACTOR } from '../lib/audit';
import type { Actor } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { getPixProvider } from '../pix';
import type { HeaderBag, PixEvent, PixProvider } from '../pix/provider';
import * as stock from './stock';
import { orderEvent, type StockLine } from './stock';

type PaidEvent = Extract<PixEvent, { type: 'pix.paid' }>;
type RefundedEvent = Extract<PixEvent, { type: 'pix.refunded' }>;

interface OrderRow {
  id: string;
  number: number;
  paymentStatus: string;
  fulfillmentStatus: string;
  reservationStatus: string;
  shippingCents: number;
  discountCents: number;
  totalCents: number;
}
interface ChargeRow {
  id: string;
  orderId: string;
  amountCents: number;
  providerChargeId: string;
}

/**
 * Entrada do webhook do provedor. A autenticidade é verificada ANTES de qualquer leitura do corpo.
 * Eventos sem assinatura válida nunca tocam o banco.
 */
export async function handleWebhook(rawBody: Buffer, headers: HeaderBag): Promise<{ result: string }> {
  const provider = getPixProvider(); // lança 503 se o Pix estiver desabilitado/não homologado
  if (!provider.verifyWebhook(rawBody, headers)) {
    throw new AppError(401, 'assinatura_invalida', 'Assinatura do evento inválida.');
  }
  const event = provider.parseWebhook(rawBody);
  return { result: await processProviderEvent(provider, event) };
}

/**
 * Processa um evento (pago/estornado) em UMA transação. Idempotente em dois níveis:
 *  1) provider_events UNIQUE(provider, event_id) — o mesmo evento reenviado não faz nada;
 *  2) payments UNIQUE(charge_id) e cash_entries UNIQUE(payment_id) — eventos diferentes para a mesma cobrança não duplicam.
 */
export async function processProviderEvent(provider: PixProvider, ev: PixEvent): Promise<string> {
  return tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO provider_events (provider, event_id, type, provider_charge_id, payload, result)
       VALUES ($1,$2,$3,$4,$5,'processando') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [provider.name, ev.eventId, ev.type, ev.providerChargeId, JSON.stringify(ev.raw)],
    );
    if (ins.rowCount === 0) return 'duplicado';
    const result = ev.type === 'pix.paid' ? await applyPaid(c, provider, ev) : await applyRefunded(c, provider, ev);
    await c.query(`UPDATE provider_events SET result = $2 WHERE id = $1`, [ins.rows[0].id, result]);
    return result;
  });
}

async function loadItems(c: PoolClient, orderId: string): Promise<StockLine[]> {
  return q<StockLine>(
    c,
    `SELECT sku_id, quantity, product_name || ' ' || variant_name AS label FROM order_items WHERE order_id = $1 ORDER BY sku_id`,
    [orderId],
  );
}

async function applyPaid(c: PoolClient, provider: PixProvider, ev: PaidEvent): Promise<string> {
  const charge = await q1<ChargeRow>(c, `SELECT id, order_id, amount_cents, provider_charge_id FROM pix_charges WHERE provider = $1 AND provider_charge_id = $2 FOR UPDATE`, [
    provider.name,
    ev.providerChargeId,
  ]);
  if (!charge) return 'cobranca_desconhecida';
  if (ev.status !== 'CONCLUIDA') return 'status_ignorado';

  // Valor divergente: não confirma. Fica registrado para conciliação e a reserva segue até o vencimento.
  if (ev.amountCents !== charge.amountCents) {
    await orderEvent(c, charge.orderId, 'alerta_pagamento', SYSTEM_ACTOR, `Evento de pagamento rejeitado: valor recebido ${ev.amountCents} difere do esperado ${charge.amountCents} (centavos).`, false);
    await audit(c, SYSTEM_ACTOR, 'pagamento.valor_divergente', 'pix_charge', charge.id, { esperado: charge.amountCents, recebido: ev.amountCents });
    return 'rejeitado_valor';
  }

  const already = await q1(c, `SELECT id FROM payments WHERE charge_id = $1`, [charge.id]);
  if (already) return 'duplicado_cobranca';

  const order = await q1<OrderRow>(
    c,
    `SELECT id, number, payment_status, fulfillment_status, reservation_status, shipping_cents, discount_cents, total_cents FROM orders WHERE id = $1 FOR UPDATE`,
    [charge.orderId],
  );
  if (!order) return 'pedido_inexistente';

  const settledAt = ev.settledAt;

  // (a) Pix dentro da reserva: pagamento + baixa de estoque + entrada no caixa na MESMA transação.
  if (order.paymentStatus === 'pendente' && order.reservationStatus === 'ativa') {
    const paymentId = await insertPayment(c, order, charge, ev, false);
    const items = await loadItems(c, order.id);
    const backorder = await stock.openExceptionQtyBySku(c, order.id);
    await stock.consumeReservation(c, order, items, backorder);
    await c.query(`UPDATE pix_charges SET status = 'paga', settled_at = $2 WHERE id = $1`, [charge.id, settledAt]);
    await c.query(
      `UPDATE orders SET payment_status = 'pago', fulfillment_status = 'pago', reservation_status = 'consumida',
              paid_at = $2, updated_at = now() WHERE id = $1`,
      [order.id, settledAt],
    );
    await orderEvent(c, order.id, 'pago', SYSTEM_ACTOR, 'Pix confirmado. Seu pedido entrou na fila de separação.', true, 'aguardando_pagamento', 'pago');
    if (backorder.size > 0) {
      await orderEvent(c, order.id, 'excecao_estoque', SYSTEM_ACTOR, 'Pago com exceção de estoque aberta (avaria). Expedição bloqueada até resolver.', false);
    }
    void paymentId;
    return 'confirmado';
  }

  // (b) Pix descoberto depois que a reserva foi liberada: registra o recebimento e manda para análise.
  if (order.paymentStatus === 'expirado' || order.paymentStatus === 'cancelado') {
    await insertPayment(c, order, charge, ev, true);
    await c.query(`UPDATE pix_charges SET status = 'paga', settled_at = $2 WHERE id = $1`, [charge.id, settledAt]);
    await c.query(
      `UPDATE orders SET payment_status = 'pago', fulfillment_status = 'em_analise', late_payment = true, paid_at = $2,
              analysis_reason = 'Pix recebido após o vencimento; o estoque já foi liberado. Confirme o estoque antes de separar, ou estorne.',
              updated_at = now() WHERE id = $1`,
      [order.id, settledAt],
    );
    await orderEvent(c, order.id, 'pago_tardio', SYSTEM_ACTOR, 'Recebemos seu Pix após o vencimento. Estamos confirmando a disponibilidade dos itens.', true, order.fulfillmentStatus, 'em_analise');
    await orderEvent(c, order.id, 'alerta_pagamento', SYSTEM_ACTOR, 'Pagamento tardio registrado no caixa. Pedido em análise.', false);
    await audit(c, SYSTEM_ACTOR, 'pagamento.tardio', 'order', order.id, { number: order.number });
    return 'pago_apos_vencimento';
  }

  return 'ignorado_estado_pedido';
}

async function insertPayment(c: PoolClient, order: OrderRow, charge: ChargeRow, ev: PaidEvent, late: boolean): Promise<number> {
  const p = await q1<{ id: number }>(
    c,
    `INSERT INTO payments (order_id, charge_id, amount_cents, fee_cents, settled_at, provider_event_id, late)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [order.id, charge.id, charge.amountCents, ev.feeCents, ev.settledAt, ev.eventId, late],
  );
  await c.query(
    `INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, shipping_cents, discount_cents, fee_cents, description, occurred_at)
     VALUES ('recebimento',$1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, p!.id, charge.amountCents, order.shippingCents, order.discountCents, ev.feeCents, `Pix do pedido #${order.number}${late ? ' (recebido após o vencimento)' : ''}`, ev.settledAt],
  );
  return p!.id;
}

async function applyRefunded(c: PoolClient, provider: PixProvider, ev: RefundedEvent): Promise<string> {
  void provider;
  const refund = await q1<{ id: string; orderId: string; paymentId: number; amountCents: number; status: string; restock: boolean; requestedBy: string | null; reason: string }>(
    c,
    `SELECT id, order_id, payment_id, amount_cents, status, restock, requested_by, reason FROM refunds WHERE provider_refund_id = $1 FOR UPDATE`,
    [ev.providerRefundId],
  );
  if (!refund) return 'estorno_desconhecido';
  if (refund.status === 'confirmado') return 'duplicado_estorno';
  if (ev.amountCents !== refund.amountCents) {
    await audit(c, SYSTEM_ACTOR, 'estorno.valor_divergente', 'refund', refund.id, { esperado: refund.amountCents, recebido: ev.amountCents });
    return 'rejeitado_valor';
  }
  const order = await q1<OrderRow>(
    c,
    `SELECT id, number, payment_status, fulfillment_status, reservation_status, shipping_cents, discount_cents, total_cents FROM orders WHERE id = $1 FOR UPDATE`,
    [refund.orderId],
  );
  if (!order) return 'pedido_inexistente';

  await c.query(`UPDATE refunds SET status = 'confirmado', confirmed_at = $2 WHERE id = $1`, [refund.id, ev.settledAt]);
  // O recebimento original permanece intacto no histórico; o estorno entra como saída vinculada ao pedido.
  await c.query(
    `INSERT INTO cash_entries (kind, order_id, payment_id, refund_id, gross_cents, description, occurred_at, created_by, authorized_by)
     VALUES ('estorno',$1,$2,$3,$4,$5,$6,$7,$7)`,
    [order.id, refund.paymentId, refund.id, refund.amountCents, `Estorno do pedido #${order.number}: ${refund.reason}`, ev.settledAt, refund.requestedBy],
  );
  const items = await loadItems(c, order.id);
  if (refund.restock && order.reservationStatus === 'consumida') {
    await stock.restockOrder(c, order, items, `Estorno do pedido #${order.number} com retorno ao estoque`, refund.requestedBy);
  }
  await stock.cancelOpenExceptions(c, order.id, 'Pedido estornado');
  const newFulfillment = order.fulfillmentStatus === 'concluido' ? 'concluido' : 'cancelado';
  await c.query(`UPDATE orders SET payment_status = 'estornado', fulfillment_status = $2, updated_at = now() WHERE id = $1`, [order.id, newFulfillment]);
  await orderEvent(c, order.id, 'estornado', SYSTEM_ACTOR, 'Pagamento estornado.', true, order.fulfillmentStatus, newFulfillment);
  return 'estorno_confirmado';
}

/**
 * Pergunta ao provedor se a cobrança de um pedido já foi paga e, se sim, aplica como evento sintético
 * (id estável "recon:<cobrança>", então repetir é seguro). Usado no vencimento e no botão "atualizar".
 */
export async function reconcileCharge(provider: PixProvider, charge: { providerChargeId: string }): Promise<'paga' | 'nao_paga'> {
  const st = await provider.getCharge(charge.providerChargeId);
  if (st.status !== 'CONCLUIDA' || !st.settledAt) return 'nao_paga';
  await processProviderEvent(provider, {
    type: 'pix.paid',
    eventId: `recon:${charge.providerChargeId}`,
    providerChargeId: charge.providerChargeId,
    amountCents: st.amountCents,
    status: 'CONCLUIDA',
    settledAt: st.settledAt,
    feeCents: st.feeCents,
    raw: { origem: 'conciliacao', charge: st },
  });
  return 'paga';
}

// ---------------------------------------------------------------------------
// Pagamento combinado com a loja (retirada/entrega): confirmado por uma pessoa da equipe
// ---------------------------------------------------------------------------
export type LocalMethod = 'dinheiro' | 'cartao' | 'pix_loja' | 'outro';
const LOCAL_LABEL: Record<LocalMethod, string> = { dinheiro: 'dinheiro', cartao: 'cartão', pix_loja: 'Pix direto na conta da loja', outro: 'outra forma' };

/**
 * Registra o recebimento de um pedido de pagamento local. Pagamento + baixa de estoque + entrada no caixa
 * acontecem na MESMA transação; repetir a chamada não duplica nada (a segunda recebe 409).
 */
export async function confirmLocalPayment(c: PoolClient, actor: Actor, orderId: string, method: LocalMethod, note?: string): Promise<void> {
  const order = await q1<OrderRow & { paymentMethod: string; reservationExpiresAt: Date }>(
    c,
    `SELECT id, number, payment_status, fulfillment_status, reservation_status, shipping_cents, discount_cents, total_cents, payment_method, reservation_expires_at
       FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!order) throw notFound('Pedido não encontrado.');
  if (order.paymentMethod !== 'local') throw conflict('Este pedido é de Pix: o pagamento só é confirmado pelo banco.', 'pedido_pix');
  if (order.paymentStatus !== 'pendente') throw conflict('Este pedido não está mais aguardando pagamento.', 'pedido_nao_pendente');
  if (order.reservationStatus !== 'ativa' || order.reservationExpiresAt.getTime() <= Date.now()) {
    throw conflict('A reserva deste pedido venceu. Cancele o pedido ou peça para a cliente refazê-lo.', 'reserva_vencida');
  }
  const now = new Date();
  const pay = await q1<{ id: number }>(
    c,
    `INSERT INTO payments (order_id, charge_id, amount_cents, fee_cents, settled_at, method, confirmed_by, late)
     VALUES ($1,NULL,$2,0,$3,$4,$5,false) RETURNING id`,
    [order.id, order.totalCents, now, method, actor.id],
  );
  await c.query(
    `INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, shipping_cents, discount_cents, fee_cents, description, occurred_at, created_by)
     VALUES ('recebimento',$1,$2,$3,$4,$5,0,$6,$7,$8)`,
    [order.id, pay!.id, order.totalCents, order.shippingCents, order.discountCents, `Pedido #${order.number} pago em ${LOCAL_LABEL[method]}${note ? ` (${note})` : ''}`, now, actor.id],
  );
  const items = await loadItems(c, order.id);
  const backorder = await stock.openExceptionQtyBySku(c, order.id);
  await stock.consumeReservation(c, order, items, backorder);
  await c.query(
    `UPDATE orders SET payment_status = 'pago', fulfillment_status = 'pago', reservation_status = 'consumida', paid_at = $2, updated_at = now() WHERE id = $1`,
    [order.id, now],
  );
  await orderEvent(c, order.id, 'pago', actor, `Pagamento confirmado pela loja (${LOCAL_LABEL[method]}).`, true, 'aguardando_pagamento', 'pago');
  await audit(c, actor, 'pagamento.confirmar_local', 'order', order.id, { number: order.number, method, amountCents: order.totalCents });
}

/** Estorno de pagamento local: devolução feita pela loja (sem provedor); confirmado na hora, com saída ligada ao pedido. */
export async function refundLocalPayment(c: PoolClient, actor: Actor, refundId: string): Promise<void> {
  const refund = await q1<{ id: string; orderId: string; paymentId: number; amountCents: number; restock: boolean; reason: string }>(
    c,
    `SELECT id, order_id, payment_id, amount_cents, restock, reason FROM refunds WHERE id = $1 AND status = 'solicitado' FOR UPDATE`,
    [refundId],
  );
  if (!refund) throw conflict('Estorno não está pendente.', 'estorno_invalido');
  const order = await q1<OrderRow>(
    c,
    `SELECT id, number, payment_status, fulfillment_status, reservation_status, shipping_cents, discount_cents, total_cents FROM orders WHERE id = $1 FOR UPDATE`,
    [refund.orderId],
  );
  if (!order) throw notFound('Pedido não encontrado.');
  const now = new Date();
  await c.query(`UPDATE refunds SET status = 'confirmado', confirmed_at = $2 WHERE id = $1`, [refund.id, now]);
  await c.query(
    `INSERT INTO cash_entries (kind, order_id, payment_id, refund_id, gross_cents, description, occurred_at, created_by, authorized_by)
     VALUES ('estorno',$1,$2,$3,$4,$5,$6,$7,$7)`,
    [order.id, refund.paymentId, refund.id, refund.amountCents, `Devolução do pedido #${order.number}: ${refund.reason}`, now, actor.id],
  );
  if (refund.restock && order.reservationStatus === 'consumida') {
    await stock.restockOrder(c, order, await loadItems(c, order.id), `Estorno do pedido #${order.number} com retorno ao estoque`, actor.id);
  }
  await stock.cancelOpenExceptions(c, order.id, 'Pedido estornado');
  const next = order.fulfillmentStatus === 'concluido' ? 'concluido' : 'cancelado';
  await c.query(`UPDATE orders SET payment_status = 'estornado', fulfillment_status = $2, updated_at = now() WHERE id = $1`, [order.id, next]);
  await orderEvent(c, order.id, 'estornado', actor, 'Pagamento devolvido pela loja.', true, order.fulfillmentStatus, next);
}
