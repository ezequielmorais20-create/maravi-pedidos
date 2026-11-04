import QRCode from 'qrcode';
import type { PoolClient } from 'pg';
import { pool, q, q1, tx, type Db, type Row } from '../db';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit';
import { AppError, conflict, notFound, pgCode, pgConstraint, unprocessable } from '../lib/errors';
import { percentOfFloor } from '../lib/money';
import { getPixProvider, getSimulatedProvider } from '../pix';
import { handleWebhook, reconcileCharge, refundLocalPayment } from './payments';
import { checkTransition } from '../lib/fulfillment';
import { etaText, getSettings, listZones, matchZone } from './settings';
import * as stock from './stock';
import { orderEvent, type StockLine } from './stock';

// ---------------------------------------------------------------------------
// Precificação do carrinho (servidor é a fonte da verdade: preço, estoque, frete)
// ---------------------------------------------------------------------------
export interface CartInput {
  items: { skuId: string; quantity: number }[];
  deliveryMode: 'retirada' | 'entrega';
  addressId?: string | null;
  paymentMethod?: 'pix' | 'local';
}

export interface PricedLine {
  skuId: string;
  sku: string;
  productName: string;
  variantName: string;
  unitPriceCents: number;
  unitCostCents: number;
  quantity: number;
  lineTotalCents: number;
  available: number;
  label: string;
}
export interface Priced {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  zoneName: string | null;
  etaText: string;
  address: Row | null;
  deliveryMode: 'retirada' | 'entrega';
  reservaMinutos: number;
  reservaLocalHoras: number;
  paymentMethod: 'pix' | 'local';
  allAvailable: boolean;
}

export async function priceCart(db: Db, userId: string, input: CartInput, strictStock: boolean): Promise<Priced> {
  const merged = new Map<string, number>();
  for (const it of input.items) merged.set(it.skuId, (merged.get(it.skuId) ?? 0) + it.quantity);
  if (merged.size === 0) throw unprocessable('A sacola está vazia.', 'sacola_vazia');
  for (const [, qty] of merged) if (qty > 99) throw unprocessable('Quantidade máxima por item: 99.', 'quantidade_invalida');

  const rows = await q<{
    id: string; sku: string; variantName: string; priceCents: number; costCents: number; active: boolean; available: number;
    productName: string; productStatus: string; categoryActive: boolean;
  }>(
    db,
    `SELECT s.id, s.sku, s.variant_name, s.price_cents, s.cost_cents, s.active,
            (s.stock_physical - s.stock_reserved - s.stock_damaged) AS available,
            p.name AS product_name, p.status AS product_status, c.active AS category_active
       FROM skus s JOIN products p ON p.id = s.product_id JOIN categories c ON c.id = p.category_id
      WHERE s.id = ANY($1::uuid[])`,
    [[...merged.keys()]],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const lines: PricedLine[] = [];
  for (const [skuId, quantity] of merged) {
    const r = byId.get(skuId);
    if (!r || !r.active || r.productStatus !== 'publicado' || !r.categoryActive) {
      throw unprocessable(`${r ? r.productName : 'Um item da sacola'} não está mais disponível.`, 'item_indisponivel', { skuId });
    }
    const label = r.variantName && r.variantName !== 'Único' ? `${r.productName} (${r.variantName})` : r.productName;
    if (strictStock && r.available < quantity) {
      throw new AppError(409, 'estoque_insuficiente', `Estoque insuficiente para ${label}: restam ${Math.max(0, r.available)}.`, { skuId, available: Math.max(0, r.available) });
    }
    lines.push({
      skuId, sku: r.sku, productName: r.productName, variantName: r.variantName, unitPriceCents: r.priceCents, unitCostCents: r.costCents,
      quantity, lineTotalCents: r.priceCents * quantity, available: Math.max(0, r.available), label,
    });
  }

  const settings = await getSettings(db);
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const method = input.paymentMethod ?? 'local';
  if (method === 'local' && !settings.pagamentoLocalAtivo) throw unprocessable('O pagamento combinado com a loja está desativado no momento.', 'pagamento_local_desativado');
  const discount = method === 'pix' ? percentOfFloor(subtotal, settings.descontoPixPercent) : 0; // desconto Pix só vale para Pix

  let shipping = 0;
  let zoneName: string | null = null;
  let eta = settings.retiradaPrazo;
  let address: Row | null = null;

  if (input.deliveryMode === 'retirada') {
    if (!settings.retiradaAtiva) throw unprocessable('A retirada na loja está desativada no momento.', 'retirada_desativada');
  } else {
    if (!settings.entregaAtiva) throw unprocessable('A entrega está desativada no momento.', 'entrega_desativada');
    if (!input.addressId) throw unprocessable('Escolha um endereço de entrega.', 'endereco_obrigatorio');
    address = (await q1(db, `SELECT * FROM addresses WHERE id = $1 AND user_id = $2`, [input.addressId, userId])) ?? null;
    if (!address) throw notFound('Endereço não encontrado.');
    const zones = await listZones(db, true);
    const full = matchZone(zones, String(address.neighborhood));
    if (!full) throw unprocessable(`Ainda não entregamos no bairro ${address.neighborhood}. Você pode retirar na loja.`, 'area_nao_atendida');
    shipping = full.feeCents;
    zoneName = full.name;
    eta = etaText(full);
  }

  const total = subtotal - discount + shipping;
  return {
    lines, subtotalCents: subtotal, discountCents: discount, shippingCents: shipping, totalCents: total,
    zoneName, etaText: eta, address, deliveryMode: input.deliveryMode, reservaMinutos: settings.reservaMinutos, reservaLocalHoras: settings.reservaLocalHoras, paymentMethod: method,
    allAvailable: lines.every((l) => l.available >= l.quantity),
  };
}

export async function quote(userId: string, input: CartInput) {
  const p = await priceCart(pool, userId, input, false);
  return {
    items: p.lines.map(({ skuId, productName, variantName, unitPriceCents, quantity, lineTotalCents, available }) => ({
      skuId, productName, variantName, unitPriceCents, quantity, lineTotalCents, available,
    })),
    subtotalCents: p.subtotalCents,
    discountCents: p.discountCents,
    shippingCents: p.shippingCents,
    totalCents: p.totalCents,
    deliveryMode: p.deliveryMode,
    zoneName: p.zoneName,
    etaText: p.etaText,
    reservaMinutos: p.reservaMinutos,
    reservaLocalHoras: p.reservaLocalHoras,
    paymentMethod: p.paymentMethod,
    allAvailable: p.allAvailable,
  };
}

// ---------------------------------------------------------------------------
// Checkout: reserva + pedido + cobrança Pix
// ---------------------------------------------------------------------------
export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string | null;
}

export async function createCheckout(customer: Customer, input: CartInput & { idempotencyKey: string }) {
  const local = (input.paymentMethod ?? 'local') === 'local';
  const provider = local ? null : getPixProvider(); // falha cedo (503) se o Pix está desabilitado: nada é reservado

  const existing = await q1<{ id: string }>(pool, `SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [customer.id, input.idempotencyKey]);
  if (existing) return getCustomerOrder(customer.id, existing.id);

  let orderId: string;
  let expiresAt: Date;
  let totalCents: number;
  try {
    ({ orderId, expiresAt, totalCents } = await tx(async (c) => {
      // Preço, estoque e frete são revalidados aqui, dentro da mesma transação que reserva o estoque.
      const priced = await priceCart(c, customer.id, input, true);
      const expires = new Date(Date.now() + (local ? priced.reservaLocalHoras * 3_600_000 : priced.reservaMinutos * 60_000));
      const a = priced.address;
      const addressSnapshot = a
        ? {
            recipient: a.recipient, phone: a.phone, cep: a.cep, street: a.street, number: a.number, complement: a.complement,
            neighborhood: a.neighborhood, city: a.city, state: a.state, reference: a.reference,
          }
        : null;
      const o = await q1<{ id: string; number: number }>(
        c,
        `INSERT INTO orders (user_id, idempotency_key, delivery_mode, subtotal_cents, discount_cents, shipping_cents, total_cents,
                             shipping_zone_name, eta_text, address, customer_name, customer_phone, customer_email, reservation_expires_at, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, number`,
        [
          customer.id, input.idempotencyKey, priced.deliveryMode, priced.subtotalCents, priced.discountCents, priced.shippingCents, priced.totalCents,
          priced.zoneName, priced.etaText, addressSnapshot ? JSON.stringify(addressSnapshot) : null, customer.name, customer.phone, customer.email, expires, local ? 'local' : 'pix',
        ],
      );
      for (const l of priced.lines) {
        // preço e custo gravados no momento da compra
        await c.query(
          `INSERT INTO order_items (order_id, sku_id, product_name, variant_name, sku_code, unit_price_cents, unit_cost_cents, quantity, line_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [o!.id, l.skuId, l.productName, l.variantName, l.sku, l.unitPriceCents, l.unitCostCents, l.quantity, l.lineTotalCents],
        );
      }
      await stock.reserveForOrder(c, o!, priced.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, label: l.label })), null);
      await orderEvent(c, o!.id, 'criado', { id: customer.id, role: 'cliente', name: customer.name }, local ? 'Pedido recebido. Pague na retirada ou na entrega; a loja confirma o pagamento.' : 'Pedido criado. Aguardando o pagamento por Pix.', true, null, 'aguardando_pagamento');
      return { orderId: o!.id, expiresAt: expires, totalCents: priced.totalCents };
    }));
  } catch (e) {
    // Duas requisições simultâneas com a mesma chave: a perdedora devolve o pedido da vencedora.
    if (pgCode(e) === '23505' && pgConstraint(e) === 'orders_idem_idx') {
      const again = await q1<{ id: string }>(pool, `SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [customer.id, input.idempotencyKey]);
      if (again) return getCustomerOrder(customer.id, again.id);
    }
    throw e;
  }

  if (local || !provider) return getCustomerOrder(customer.id, orderId); // pagamento local: sem cobrança Pix

  // A chamada ao provedor acontece FORA da transação do banco. Se falhar, a reserva é desfeita.
  try {
    const created = await provider.createCharge({
      reference: orderId.replace(/-/g, ''),
      amountCents: totalCents,
      expiresAt,
      description: 'Pedido MARAVI',
    });
    await tx(async (c) => {
      await c.query(
        `INSERT INTO pix_charges (order_id, provider, provider_charge_id, amount_cents, brcode, simulated, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, provider.name, created.providerChargeId, totalCents, created.brcode, provider.simulated, expiresAt],
      );
      await orderEvent(c, orderId, 'pix_gerado', SYSTEM_ACTOR, 'Pix gerado. Pague até o vencimento para garantir seus itens.', true);
    });
  } catch (err) {
    await tx((c) => cancelUnpaidTx(c, orderId, 'Falha ao gerar a cobrança Pix.', SYSTEM_ACTOR));
    console.error('[checkout] falha ao criar cobrança Pix:', (err as Error).message);
    throw new AppError(502, 'pix_falhou', 'Não foi possível gerar o Pix agora. Seus itens foram liberados; tente novamente.');
  }
  return getCustomerOrder(customer.id, orderId);
}

/** Cancela pedido ainda não pago, liberando a reserva. Retorna false se o pedido já mudou de estado. */
export async function cancelUnpaidTx(c: PoolClient, orderId: string, reason: string, actor: Actor): Promise<boolean> {
  const o = await q1<{ id: string; number: number; paymentStatus: string; reservationStatus: string }>(
    c,
    `SELECT id, number, payment_status, reservation_status FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!o || o.paymentStatus !== 'pendente' || o.reservationStatus !== 'ativa') return false;
  const items = await q<StockLine>(c, `SELECT sku_id, quantity FROM order_items WHERE order_id = $1 ORDER BY sku_id`, [orderId]);
  await stock.releaseReservation(c, o, items, `Pedido #${o.number} cancelado: ${reason}`, actor.id);
  await stock.cancelOpenExceptions(c, orderId, reason);
  await c.query(`UPDATE pix_charges SET status = 'cancelada' WHERE order_id = $1 AND status = 'ativa'`, [orderId]);
  await c.query(
    `UPDATE orders SET payment_status = 'cancelado', fulfillment_status = 'cancelado', reservation_status = 'liberada', updated_at = now() WHERE id = $1`,
    [orderId],
  );
  await orderEvent(c, orderId, 'cancelado', actor, reason, true, 'aguardando_pagamento', 'cancelado');
  if (actor.id) await audit(c, actor, 'pedido.cancelar', 'order', orderId, { number: o.number, reason });
  return true;
}

/**
 * Cancelamento de pedido não pago (cliente ou equipe). Concilia com o provedor primeiro:
 * se o Pix já foi pago, o pedido é confirmado em vez de cancelado.
 */
export async function cancelUnpaidOrder(actor: Actor, orderId: string, ownerId?: string): Promise<{ cancelled: boolean }> {
  const o = await q1<{ id: string; userId: string; paymentStatus: string }>(pool, `SELECT id, user_id, payment_status FROM orders WHERE id = $1`, [orderId]);
  if (!o || (ownerId && o.userId !== ownerId)) throw notFound('Pedido não encontrado.');
  if (o.paymentStatus !== 'pendente') throw conflict('Este pedido não está mais aguardando pagamento.', 'pedido_nao_pendente');

  const ch = await q1<{ providerChargeId: string }>(pool, `SELECT provider_charge_id FROM pix_charges WHERE order_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`, [orderId]);
  const provider = ch ? getPixProvider() : null;
  if (ch && provider && (await reconcileCharge(provider, ch)) === 'paga') {
    throw conflict('O pagamento deste pedido já foi confirmado, então ele não pode ser cancelado.', 'pedido_ja_pago');
  }
  const done = await tx((c) => cancelUnpaidTx(c, orderId, actor.role === 'cliente' ? 'Cancelado pela cliente.' : 'Cancelado pela equipe.', actor));
  if (!done) throw conflict('Este pedido não está mais aguardando pagamento.', 'pedido_nao_pendente');
  if (ch && provider) await provider.cancelCharge(ch.providerChargeId).catch(() => undefined);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Visão da cliente (somente os próprios pedidos; 404 para pedido de outra pessoa)
// ---------------------------------------------------------------------------
const ORDER_ITEMS_SQL = `
  SELECT oi.id, oi.product_name, oi.variant_name, oi.sku_code, oi.unit_price_cents, oi.quantity, oi.line_total_cents,
         COALESCE(s.image_url, (SELECT url FROM product_images i WHERE i.product_id = s.product_id ORDER BY i.sort_order, i.id LIMIT 1)) AS image
    FROM order_items oi JOIN skus s ON s.id = oi.sku_id
   WHERE oi.order_id = $1 ORDER BY oi.product_name, oi.variant_name`;

export async function getCustomerOrder(userId: string, orderId: string): Promise<Row> {
  const o = await q1(
    pool,
    `SELECT id, number, delivery_mode, subtotal_cents, discount_cents, shipping_cents, total_cents, shipping_zone_name, eta_text, address,
            payment_status, fulfillment_status, reservation_expires_at, paid_at, created_at, payment_method
       FROM orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId],
  );
  if (!o) throw notFound('Pedido não encontrado.');
  const items = await q(pool, ORDER_ITEMS_SQL, [orderId]);
  const timeline = await q(pool, `SELECT kind, to_status, note, created_at FROM order_events WHERE order_id = $1 AND public ORDER BY id`, [orderId]);
  let pix: Row | null = null;
  if (o.paymentStatus === 'pendente') {
    const ch = await q1(pool, `SELECT id, brcode, amount_cents, expires_at, status, simulated FROM pix_charges WHERE order_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`, [orderId]);
    if (ch) {
      pix = {
        chargeId: ch.id,
        brcode: ch.brcode,
        amountCents: ch.amountCents,
        expiresAt: ch.expiresAt,
        simulated: ch.simulated,
        qrDataUrl: await QRCode.toDataURL(ch.brcode, { errorCorrectionLevel: 'M', margin: 2, width: 360 }),
      };
    }
  }
  return { ...o, items, timeline, pix };
}

export async function listCustomerOrders(userId: string) {
  return q(
    pool,
    `SELECT o.id, o.number, o.delivery_mode, o.total_cents, o.payment_status, o.fulfillment_status, o.created_at, o.reservation_expires_at,
            (SELECT COALESCE(SUM(quantity),0)::int FROM order_items oi WHERE oi.order_id = o.id) AS items_count,
            (SELECT string_agg(oi.product_name, ', ' ORDER BY oi.product_name) FROM order_items oi WHERE oi.order_id = o.id) AS summary
       FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [userId],
  );
}

/** "Já paguei": consulta o provedor e confirma, se for o caso (seguro repetir). */
export async function refreshCustomerPayment(userId: string, orderId: string) {
  const o = await q1<{ paymentStatus: string }>(pool, `SELECT payment_status FROM orders WHERE id = $1 AND user_id = $2`, [orderId, userId]);
  if (!o) throw notFound('Pedido não encontrado.');
  if (o.paymentStatus === 'pendente') {
    const ch = await q1<{ providerChargeId: string }>(pool, `SELECT provider_charge_id FROM pix_charges WHERE order_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`, [orderId]);
    if (ch) await reconcileCharge(getPixProvider(), ch);
  }
  return getCustomerOrder(userId, orderId);
}

// ---------------------------------------------------------------------------
// Visão da equipe (campos mascarados conforme as permissões)
// ---------------------------------------------------------------------------
export interface StaffView {
  pii: boolean; // customers.pii
  totals: boolean; // orders.totals
}

export type QueueView = 'aguardando' | 'fila' | 'analise' | 'excecoes' | 'historico';

const VIEW_SQL: Record<QueueView, { where: string; order: string }> = {
  aguardando: { where: `o.payment_status = 'pendente'`, order: `o.reservation_expires_at ASC, o.number ASC` },
  // Fila de separação: horário efetivo da liquidação informado pelo provedor, do mais antigo ao mais recente.
  // Desempate estável: número do pedido (ordem de criação).
  fila: {
    where: `o.payment_status = 'pago' AND o.fulfillment_status IN ('pago','em_separacao','pronto_retirada','saiu_entrega')`,
    order: `o.paid_at ASC, o.number ASC`,
  },
  analise: { where: `o.fulfillment_status = 'em_analise'`, order: `o.paid_at ASC, o.number ASC` },
  excecoes: { where: `EXISTS (SELECT 1 FROM order_exceptions e WHERE e.order_id = o.id AND e.status = 'aberta')`, order: `o.created_at ASC` },
  historico: { where: `o.fulfillment_status IN ('concluido','cancelado')`, order: `o.updated_at DESC` },
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

function maskOrder<T extends Row>(o: T, v: StaffView): T {
  const out: Row = { ...o };
  if (!v.pii) {
    if ('customerName' in out) out.customerName = firstName(String(out.customerName));
    delete out.customerPhone;
    delete out.customerEmail;
    delete out.address;
  }
  if (!v.totals) {
    for (const k of ['subtotalCents', 'discountCents', 'shippingCents', 'totalCents']) delete out[k];
    if (Array.isArray(out.items)) out.items = out.items.map((i: Row) => ({ ...i, unitPriceCents: undefined, lineTotalCents: undefined }));
    delete out.payment;
  }
  return out as T;
}

export async function listStaffOrders(view: QueueView, v: StaffView) {
  const def = VIEW_SQL[view];
  const rows = await q(
    pool,
    `SELECT o.id, o.number, o.delivery_mode, o.payment_status, o.fulfillment_status, o.analysis_reason, o.late_payment,
            o.total_cents, o.payment_method, o.created_at, o.paid_at, o.reservation_expires_at, o.customer_name, o.shipping_zone_name,
            (SELECT jsonb_agg(jsonb_build_object('productName', oi.product_name, 'variantName', oi.variant_name, 'sku', oi.sku_code, 'quantity', oi.quantity)
                              ORDER BY oi.product_name) FROM order_items oi WHERE oi.order_id = o.id) AS items,
            EXISTS (SELECT 1 FROM order_exceptions e WHERE e.order_id = o.id AND e.status = 'aberta') AS has_exception
       FROM orders o WHERE ${def.where} ORDER BY ${def.order} LIMIT 300`,
  );
  return rows.map((r) => maskOrder(r, v));
}

/** Todos os pedidos já feitos (qualquer status), do mais recente ao mais antigo, filtrados pelo DIA de criação no fuso da loja. */
export async function listAllStaffOrders(from: string, to: string, v: StaffView) {
  const rows = await q(
    pool,
    `SELECT o.id, o.number, o.delivery_mode, o.payment_status, o.fulfillment_status, o.total_cents, o.payment_method,
            o.created_at, o.paid_at, o.customer_name, o.shipping_zone_name,
            (SELECT jsonb_agg(jsonb_build_object('productName', oi.product_name, 'variantName', oi.variant_name, 'quantity', oi.quantity)
                              ORDER BY oi.product_name) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
      WHERE (o.created_at AT TIME ZONE 'America/Fortaleza')::date BETWEEN $1::date AND $2::date
      ORDER BY o.created_at DESC, o.number DESC
      LIMIT 2000`,
    [from, to],
  );
  return rows.map((r) => maskOrder(r, v));
}

export async function getStaffOrder(orderId: string, v: StaffView) {
  const o = await q1(pool, `SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!o) throw notFound('Pedido não encontrado.');
  const items = await q(pool, ORDER_ITEMS_SQL, [orderId]);
  const events = await q(pool, `SELECT kind, from_status, to_status, actor_name, note, public, created_at FROM order_events WHERE order_id = $1 ORDER BY id`, [orderId]);
  const exceptions = await q(
    pool,
    `SELECT e.id, e.kind, e.status, e.quantity, e.note, e.resolution, s.sku, p.name AS product_name, s.variant_name, e.created_at, e.resolved_at
       FROM order_exceptions e JOIN skus s ON s.id = e.sku_id JOIN products p ON p.id = s.product_id WHERE e.order_id = $1 ORDER BY e.created_at`,
    [orderId],
  );
  const payment = await q1(
    pool,
    `SELECT p.id, p.amount_cents, p.fee_cents, p.settled_at, p.received_at, p.late, p.method, c.provider, c.provider_charge_id, c.simulated,
            u.name AS confirmed_by_name
       FROM payments p LEFT JOIN pix_charges c ON c.id = p.charge_id LEFT JOIN users u ON u.id = p.confirmed_by WHERE p.order_id = $1 ORDER BY p.id DESC LIMIT 1`,
    [orderId],
  );
  const refunds = await q(pool, `SELECT id, amount_cents, reason, restock, status, requested_at, confirmed_at FROM refunds WHERE order_id = $1 ORDER BY requested_at`, [orderId]);
  const base: Row = { ...o, items, events, exceptions, payment: payment ?? null, refunds };
  delete base.idempotencyKey;
  const masked = maskOrder(base, v);
  if (!v.totals) masked.refunds = [];
  return masked;
}

// ---------------------------------------------------------------------------
// Status de atendimento
// ---------------------------------------------------------------------------
const PUBLIC_TEXT: Record<string, string> = {
  em_separacao: 'Seu pedido está em separação.',
  pronto_retirada: 'Seu pedido está pronto para retirada na loja.',
  saiu_entrega: 'Seu pedido saiu para entrega.',
  concluido: 'Pedido concluído. Obrigada pela compra!',
};

export async function advanceFulfillment(c: PoolClient, actor: Actor, orderId: string, to: string): Promise<void> {
  const o = await q1<{ id: string; number: number; deliveryMode: string; paymentStatus: string; fulfillmentStatus: string; reservationStatus: string }>(
    c,
    `SELECT id, number, delivery_mode, payment_status, fulfillment_status, reservation_status FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!o) throw notFound('Pedido não encontrado.');
  if (o.paymentStatus !== 'pago') throw conflict('O pedido só avança depois do pagamento confirmado.', 'pagamento_nao_confirmado');
  if (o.reservationStatus !== 'consumida') throw conflict('O estoque deste pedido ainda não foi garantido. Libere o pedido da análise primeiro.', 'estoque_nao_garantido');
  const open = await q1<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM order_exceptions WHERE order_id = $1 AND status = 'aberta'`, [orderId]);
  const check = checkTransition(o.fulfillmentStatus, to, o.deliveryMode as 'retirada' | 'entrega', open?.n ?? 0);
  if (!check.ok) throw conflict(check.message, check.code);
  await c.query(`UPDATE orders SET fulfillment_status = $2, updated_at = now() WHERE id = $1`, [orderId, to]);
  // Operador e horário ficam registrados no evento (a cliente vê só o texto e o horário).
  await orderEvent(c, orderId, 'status', actor, PUBLIC_TEXT[to] ?? null, true, o.fulfillmentStatus, to);
  await audit(c, actor, 'pedido.status', 'order', orderId, { number: o.number, from: o.fulfillmentStatus, to });
}

/** Libera um pedido pago após o vencimento: só com estoque garantido (baixa direta, exige disponível). */
export async function releaseFromAnalysis(c: PoolClient, actor: Actor, orderId: string): Promise<void> {
  const o = await q1<{ id: string; number: number; paymentStatus: string; fulfillmentStatus: string; reservationStatus: string }>(
    c,
    `SELECT id, number, payment_status, fulfillment_status, reservation_status FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!o) throw notFound('Pedido não encontrado.');
  if (o.fulfillmentStatus !== 'em_analise' || o.paymentStatus !== 'pago') throw conflict('Este pedido não está em análise.', 'pedido_nao_em_analise');
  if (o.reservationStatus === 'liberada') {
    const items = await q<StockLine>(
      c,
      `SELECT sku_id, quantity, product_name || ' ' || variant_name AS label FROM order_items WHERE order_id = $1 ORDER BY sku_id`,
      [orderId],
    );
    // Se faltar unidade, lança estoque_insuficiente (409) e nada é alterado: a equipe repõe ou estorna.
    await stock.sellDirect(c, o, items, `Liberação do pedido #${o.number} (Pix pago após o vencimento)`, actor.id);
  }
  await c.query(`UPDATE orders SET reservation_status = 'consumida', fulfillment_status = 'pago', analysis_reason = NULL, updated_at = now() WHERE id = $1`, [orderId]);
  await orderEvent(c, orderId, 'liberado', actor, 'Estoque confirmado. Seu pedido entrou na fila de separação.', true, 'em_analise', 'pago');
  await audit(c, actor, 'pedido.liberar_analise', 'order', orderId, { number: o.number });
}

// ---------------------------------------------------------------------------
// Estorno
// ---------------------------------------------------------------------------
export async function requestRefund(actor: Actor, orderId: string, input: { reason: string; restock: boolean }) {
  const localPay = await q1<{ method: string }>(pool, `SELECT method FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]);
  if (localPay && localPay.method !== 'pix') {
    // Pagamento local: a loja devolve o valor ela mesma e registra aqui (sem provedor).
    const id = await tx(async (c) => {
      const o = await q1<{ id: string; number: number; paymentStatus: string }>(c, `SELECT id, number, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o) throw notFound('Pedido não encontrado.');
      if (o.paymentStatus !== 'pago') throw conflict('Só é possível estornar pedido com pagamento confirmado.', 'estorno_invalido');
      const pay = await q1<{ id: number; amountCents: number }>(c, `SELECT id, amount_cents FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]);
      const open = await q1(c, `SELECT id FROM refunds WHERE order_id = $1 AND status IN ('solicitado','confirmado')`, [orderId]);
      if (open) throw conflict('Já existe um estorno solicitado ou confirmado para este pedido.', 'estorno_duplicado');
      const r = await q1<{ id: string }>(c, `INSERT INTO refunds (order_id, payment_id, amount_cents, reason, restock, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orderId, pay!.id, pay!.amountCents, input.reason, input.restock, actor.id]);
      await audit(c, actor, 'estorno.solicitar', 'order', orderId, { number: o.number, amountCents: pay!.amountCents, reason: input.reason, restock: input.restock, local: true });
      await refundLocalPayment(c, actor, r!.id);
      return r!.id;
    });
    return { refundId: id, status: 'confirmado' };
  }
  const provider = getPixProvider();
  const created = await tx(async (c) => {
    const o = await q1<{ id: string; number: number; paymentStatus: string }>(c, `SELECT id, number, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw notFound('Pedido não encontrado.');
    if (o.paymentStatus !== 'pago') throw conflict('Só é possível estornar pedido com pagamento confirmado.', 'estorno_invalido');
    const pay = await q1<{ id: number; amountCents: number; providerChargeId: string }>(
      c,
      `SELECT p.id, p.amount_cents, ch.provider_charge_id FROM payments p JOIN pix_charges ch ON ch.id = p.charge_id WHERE p.order_id = $1 ORDER BY p.id DESC LIMIT 1`,
      [orderId],
    );
    if (!pay) throw conflict('Pedido sem pagamento registrado.', 'estorno_invalido');
    const open = await q1(c, `SELECT id FROM refunds WHERE order_id = $1 AND status IN ('solicitado','confirmado')`, [orderId]);
    if (open) throw conflict('Já existe um estorno solicitado ou confirmado para este pedido.', 'estorno_duplicado');
    const r = await q1<{ id: string }>(
      c,
      `INSERT INTO refunds (order_id, payment_id, amount_cents, reason, restock, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orderId, pay.id, pay.amountCents, input.reason, input.restock, actor.id],
    );
    await audit(c, actor, 'estorno.solicitar', 'order', orderId, { number: o.number, amountCents: pay.amountCents, reason: input.reason, restock: input.restock });
    await orderEvent(c, orderId, 'estorno_solicitado', actor, `Estorno solicitado: ${input.reason}`, false);
    return { refundId: r!.id, providerChargeId: pay.providerChargeId, amountCents: pay.amountCents };
  });

  let providerRefundId: string;
  try {
    ({ providerRefundId } = await provider.refund({ providerChargeId: created.providerChargeId, amountCents: created.amountCents, refundRef: created.refundId }));
  } catch (err) {
    await pool.query(`UPDATE refunds SET status = 'falhou' WHERE id = $1`, [created.refundId]);
    throw err instanceof AppError ? err : new AppError(502, 'estorno_falhou', 'O provedor não aceitou o estorno. Tente novamente.');
  }
  await pool.query(`UPDATE refunds SET provider_refund_id = $2 WHERE id = $1`, [created.refundId, providerRefundId]);

  if (provider.simulated) {
    // Em simulação o "banco" confirma na hora, pelo mesmo caminho do webhook real (assinatura + processador).
    const ev = getSimulatedProvider().refundEvent({ providerChargeId: created.providerChargeId, providerRefundId, amountCents: created.amountCents });
    await handleWebhook(ev.body, ev.headers);
  }
  const status = await q1<{ status: string }>(pool, `SELECT status FROM refunds WHERE id = $1`, [created.refundId]);
  return { refundId: created.refundId, status: status?.status ?? 'solicitado' };
}

// ---------------------------------------------------------------------------
// Simulação (somente PIX_MODE=simulado fora de produção)
// ---------------------------------------------------------------------------
export async function simulatePixPayment(orderId: string, opts: { settledAt?: Date; deliver?: boolean; feeCents?: number } = {}) {
  const sim = getSimulatedProvider();
  const ch = await q1<{ providerChargeId: string }>(pool, `SELECT provider_charge_id FROM pix_charges WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]);
  if (!ch) throw notFound('Este pedido não tem cobrança Pix.');
  const signed = await sim.markPaid(ch.providerChargeId, { settledAt: opts.settledAt, feeCents: opts.feeCents });
  if (opts.deliver === false) return { signed, result: null as string | null };
  const r = await handleWebhook(signed.body, signed.headers);
  return { signed, result: r.result };
}
