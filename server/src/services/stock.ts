import type { PoolClient } from 'pg';
import { q, q1, type Db } from '../db';
import { audit, type Actor } from '../lib/audit';
import { AppError, conflict, notFound, pgCode } from '../lib/errors';

export type MovementKind =
  | 'entrada'
  | 'reserva'
  | 'liberacao'
  | 'venda'
  | 'devolucao'
  | 'avaria'
  | 'descarte'
  | 'recuperacao'
  | 'ajuste';

export interface StockLine {
  skuId: string;
  quantity: number;
  label?: string; // nome legível para mensagens de erro
}

interface MoveInput {
  skuId: string;
  kind: MovementKind;
  quantity: number;
  dPhysical?: number;
  dReserved?: number;
  dDamaged?: number;
  reason: string;
  actorId?: string | null;
  orderId?: string | null;
  exceptionId?: string | null;
  photoUrl?: string | null;
  /** Exige disponível (físico − reservado − avariado) ≥ 0 depois do movimento. */
  requireAvailable?: boolean;
  label?: string;
}

export interface MoveResult {
  movementId: number;
  physical: number;
  reserved: number;
  damaged: number;
  available: number;
}

/**
 * Único ponto que altera os contadores de estoque. Um UPDATE condicional atômico: sob concorrência,
 * a segunda transação espera o bloqueio da linha e reavalia a condição (READ COMMITTED),
 * então a última unidade nunca é vendida duas vezes. Os CHECKs do banco impedem estoque negativo.
 */
export async function move(c: PoolClient, m: MoveInput): Promise<MoveResult> {
  const dp = m.dPhysical ?? 0;
  const dr = m.dReserved ?? 0;
  const dd = m.dDamaged ?? 0;
  let res;
  try {
    res = await c.query(
      `UPDATE skus
          SET stock_physical = stock_physical + $2,
              stock_reserved = stock_reserved + $3,
              stock_damaged  = stock_damaged  + $4,
              updated_at = now()
        WHERE id = $1
          AND ($5::boolean = false
               OR (stock_physical + $2) - (stock_reserved + $3) - (stock_damaged + $4) >= 0)
        RETURNING stock_physical, stock_reserved, stock_damaged`,
      [m.skuId, dp, dr, dd, Boolean(m.requireAvailable)],
    );
  } catch (e) {
    if (pgCode(e) === '23514') {
      throw conflict('Movimento inválido: o estoque ficaria negativo ou inconsistente.', 'estoque_invalido', { skuId: m.skuId });
    }
    throw e;
  }
  if (res.rowCount === 0) {
    const exists = await c.query('SELECT 1 FROM skus WHERE id = $1', [m.skuId]);
    if (exists.rowCount === 0) throw notFound('SKU não encontrado.');
    throw new AppError(409, 'estoque_insuficiente', `Estoque insuficiente${m.label ? ` para ${m.label}` : ''}.`, { skuId: m.skuId });
  }
  const { stock_physical: p, stock_reserved: r, stock_damaged: d } = res.rows[0] as {
    stock_physical: number;
    stock_reserved: number;
    stock_damaged: number;
  };
  const ins = await c.query(
    `INSERT INTO stock_movements (sku_id, kind, quantity, delta_physical, delta_reserved, delta_damaged,
                                  after_physical, after_reserved, after_damaged, reason, user_id, order_id, exception_id, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [m.skuId, m.kind, m.quantity, dp, dr, dd, p, r, d, m.reason, m.actorId ?? null, m.orderId ?? null, m.exceptionId ?? null, m.photoUrl ?? null],
  );
  return { movementId: ins.rows[0].id as number, physical: p, reserved: r, damaged: d, available: p - r - d };
}

const bySku = <T extends { skuId: string }>(items: T[]): T[] => [...items].sort((a, b) => (a.skuId < b.skuId ? -1 : 1));

// ---------------------------------------------------------------------------
// Ciclo de vida do pedido
// ---------------------------------------------------------------------------

/** Reserva todas as linhas (tudo ou nada: a transação do chamador desfaz se alguma falhar). */
export async function reserveForOrder(c: PoolClient, order: { id: string; number: number }, items: StockLine[], actorId: string | null): Promise<void> {
  for (const it of bySku(items)) {
    await move(c, {
      skuId: it.skuId,
      kind: 'reserva',
      quantity: it.quantity,
      dReserved: it.quantity,
      requireAvailable: true,
      reason: `Reserva do pedido #${order.number}`,
      orderId: order.id,
      actorId,
      label: it.label,
    });
  }
}

export async function releaseReservation(
  c: PoolClient,
  order: { id: string; number: number },
  items: StockLine[],
  reason: string,
  actorId: string | null,
): Promise<void> {
  for (const it of bySku(items)) {
    await move(c, { skuId: it.skuId, kind: 'liberacao', quantity: it.quantity, dReserved: -it.quantity, reason, orderId: order.id, actorId });
  }
}

/**
 * Pix confirmado: a reserva vira venda (baixa do físico). `backorder` traz as unidades que a avaria já
 * tirou do pedido (exceção aberta): elas não saem do físico agora — ficam em falta até a reposição.
 */
export async function consumeReservation(
  c: PoolClient,
  order: { id: string; number: number },
  items: StockLine[],
  backorder: Map<string, number>,
): Promise<void> {
  for (const it of bySku(items)) {
    const missing = Math.min(it.quantity, backorder.get(it.skuId) ?? 0);
    await move(c, {
      skuId: it.skuId,
      kind: 'venda',
      quantity: it.quantity,
      dPhysical: -(it.quantity - missing),
      dReserved: -it.quantity,
      reason: `Venda do pedido #${order.number} (Pix confirmado)${missing ? ` — ${missing} un. em falta por avaria` : ''}`,
      orderId: order.id,
      actorId: null,
    });
  }
}

/** Baixa direta (pedido pago após a liberação da reserva, ou reposição de exceção). Exige estoque disponível. */
export async function sellDirect(
  c: PoolClient,
  order: { id: string; number: number },
  items: StockLine[],
  reason: string,
  actorId: string | null,
  exceptionId?: string,
): Promise<void> {
  for (const it of bySku(items)) {
    await move(c, {
      skuId: it.skuId,
      kind: 'venda',
      quantity: it.quantity,
      dPhysical: -it.quantity,
      requireAvailable: true,
      reason,
      orderId: order.id,
      actorId,
      exceptionId,
      label: it.label,
    });
  }
}

/** Devolve ao físico as unidades de um pedido pago (estorno com retorno ao estoque). */
export async function restockOrder(c: PoolClient, order: { id: string; number: number }, items: StockLine[], reason: string, actorId: string | null): Promise<void> {
  const open = await openExceptionQtyBySku(c, order.id);
  for (const it of bySku(items)) {
    // unidades com exceção aberta nunca saíram do físico (ou já voltaram em quarentena)
    const qty = it.quantity - (open.get(it.skuId) ?? 0);
    if (qty > 0) {
      await move(c, { skuId: it.skuId, kind: 'devolucao', quantity: qty, dPhysical: qty, reason, orderId: order.id, actorId });
    }
  }
}

export async function openExceptionQtyBySku(db: Db, orderId: string): Promise<Map<string, number>> {
  const rows = await q<{ skuId: string; qty: number }>(
    db,
    `SELECT sku_id, SUM(quantity)::int AS qty FROM order_exceptions WHERE order_id = $1 AND status = 'aberta' GROUP BY sku_id`,
    [orderId],
  );
  return new Map(rows.map((r) => [r.skuId, r.qty]));
}

export async function cancelOpenExceptions(c: Db, orderId: string, resolution: string): Promise<void> {
  await c.query(
    `UPDATE order_exceptions SET status = 'cancelada', resolution = $2, resolved_at = now()
      WHERE order_id = $1 AND status = 'aberta'`,
    [orderId, resolution],
  );
}

// ---------------------------------------------------------------------------
// Operações da equipe
// ---------------------------------------------------------------------------

export async function entry(c: PoolClient, actor: Actor, i: { skuId: string; quantity: number; reason: string }): Promise<MoveResult> {
  const r = await move(c, { skuId: i.skuId, kind: 'entrada', quantity: i.quantity, dPhysical: i.quantity, reason: i.reason, actorId: actor.id });
  await audit(c, actor, 'estoque.entrada', 'sku', i.skuId, { quantity: i.quantity, reason: i.reason });
  return r;
}

export async function adjust(c: PoolClient, actor: Actor, i: { skuId: string; delta: number; reason: string }): Promise<MoveResult> {
  if (i.delta === 0) throw conflict('O ajuste precisa ser diferente de zero.', 'ajuste_invalido');
  const r = await move(c, {
    skuId: i.skuId,
    kind: 'ajuste',
    quantity: Math.abs(i.delta),
    dPhysical: i.delta,
    requireAvailable: i.delta < 0, // não deixa o ajuste negativo invadir unidades reservadas
    reason: i.reason,
    actorId: actor.id,
  });
  await audit(c, actor, 'estoque.ajuste', 'sku', i.skuId, { delta: i.delta, reason: i.reason });
  return r;
}

export interface DamageResult {
  movement: MoveResult;
  deficit: number;
  exceptions: { id: string; orderId: string; orderNumber: number; quantity: number }[];
}

/**
 * Avaria: a unidade sai da venda e fica em quarentena (continua no físico).
 * - Sem pedido: se a avaria invadir unidades reservadas (disponível < 0), abre exceção para os pedidos
 *   reservados mais recentes (LIFO) até cobrir o déficit.
 * - Com pedido pago: a unidade vendida volta ao físico em quarentena e o pedido fica com exceção aberta
 *   (a expedição é bloqueada até repor ou estornar).
 */
export async function registerDamage(
  c: PoolClient,
  actor: Actor,
  i: { skuId: string; quantity: number; reason: string; orderId?: string | null; photoUrl?: string | null },
): Promise<DamageResult> {
  const sku = await q1<{ stockPhysical: number; stockDamaged: number }>(c, `SELECT stock_physical, stock_damaged FROM skus WHERE id = $1 FOR UPDATE`, [i.skuId]);
  if (!sku) throw notFound('SKU não encontrado.');

  if (i.orderId) {
    const order = await q1<{ id: string; number: number; paymentStatus: string; fulfillmentStatus: string; reservationStatus: string }>(
      c,
      `SELECT id, number, payment_status, fulfillment_status, reservation_status FROM orders WHERE id = $1 FOR UPDATE`,
      [i.orderId],
    );
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.paymentStatus !== 'pago' || order.reservationStatus !== 'consumida' || ['concluido', 'cancelado'].includes(order.fulfillmentStatus)) {
      throw conflict('A avaria só pode ser ligada a um pedido pago, com estoque baixado e ainda não concluído.', 'pedido_invalido_para_avaria');
    }
    const item = await q1<{ quantity: number }>(c, `SELECT quantity FROM order_items WHERE order_id = $1 AND sku_id = $2`, [i.orderId, i.skuId]);
    if (!item) throw conflict('Este SKU não faz parte do pedido.', 'sku_fora_do_pedido');
    const open = await q1<{ n: number }>(c, `SELECT COALESCE(SUM(quantity),0)::int AS n FROM order_exceptions WHERE order_id=$1 AND sku_id=$2 AND status='aberta'`, [i.orderId, i.skuId]);
    if (i.quantity + (open?.n ?? 0) > item.quantity) throw conflict('Quantidade avariada acima da quantidade do pedido.', 'avaria_acima_do_pedido');

    await move(c, {
      skuId: i.skuId,
      kind: 'devolucao',
      quantity: i.quantity,
      dPhysical: i.quantity,
      reason: `Unidade do pedido #${order.number} reintegrada ao físico para quarentena (avaria)`,
      orderId: i.orderId,
      actorId: actor.id,
    });
    const exc = await q1<{ id: string }>(
      c,
      `INSERT INTO order_exceptions (order_id, sku_id, quantity, kind, note, created_by) VALUES ($1,$2,$3,'avaria_pedido_pago',$4,$5) RETURNING id`,
      [i.orderId, i.skuId, i.quantity, i.reason, actor.id],
    );
    const movement = await move(c, {
      skuId: i.skuId,
      kind: 'avaria',
      quantity: i.quantity,
      dDamaged: i.quantity,
      reason: i.reason,
      orderId: i.orderId,
      exceptionId: exc!.id,
      photoUrl: i.photoUrl,
      actorId: actor.id,
    });
    await orderEvent(c, i.orderId, 'excecao_estoque', actor, `Avaria registrada (${i.quantity} un.). Expedição bloqueada até resolver a exceção.`, false);
    await audit(c, actor, 'estoque.avaria', 'sku', i.skuId, { quantity: i.quantity, reason: i.reason, orderId: i.orderId });
    return { movement, deficit: 0, exceptions: [{ id: exc!.id, orderId: i.orderId, orderNumber: order.number, quantity: i.quantity }] };
  }

  if (sku.stockPhysical - sku.stockDamaged < i.quantity) {
    throw conflict('Não há unidades suficientes fora de quarentena para registrar esta avaria.', 'avaria_acima_do_estoque');
  }
  const movement = await move(c, {
    skuId: i.skuId,
    kind: 'avaria',
    quantity: i.quantity,
    dDamaged: i.quantity,
    reason: i.reason,
    photoUrl: i.photoUrl,
    actorId: actor.id,
  });

  const created: DamageResult['exceptions'] = [];
  const deficit = Math.max(0, -movement.available);
  if (deficit > 0) {
    const owed = await q1<{ n: number }>(
      c,
      `SELECT COALESCE(SUM(e.quantity),0)::int AS n
         FROM order_exceptions e JOIN orders o ON o.id = e.order_id
        WHERE e.sku_id = $1 AND e.status = 'aberta' AND e.kind = 'avaria_reserva' AND o.reservation_status = 'ativa'`,
      [i.skuId],
    );
    let toAllocate = deficit - (owed?.n ?? 0);
    if (toAllocate > 0) {
      const candidates = await q<{ orderId: string; number: number; quantity: number; covered: number }>(
        c,
        `SELECT o.id AS order_id, o.number, oi.quantity,
                COALESCE((SELECT SUM(e.quantity) FROM order_exceptions e
                           WHERE e.order_id = o.id AND e.sku_id = oi.sku_id AND e.status = 'aberta'),0)::int AS covered
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku_id = $1 AND o.reservation_status = 'ativa' AND o.payment_status = 'pendente'
          ORDER BY o.created_at DESC, o.number DESC
          FOR UPDATE OF o`,
        [i.skuId],
      );
      for (const cand of candidates) {
        if (toAllocate <= 0) break;
        const take = Math.min(cand.quantity - cand.covered, toAllocate);
        if (take <= 0) continue;
        const exc = await q1<{ id: string }>(
          c,
          `INSERT INTO order_exceptions (order_id, sku_id, quantity, kind, note, created_by) VALUES ($1,$2,$3,'avaria_reserva',$4,$5) RETURNING id`,
          [cand.orderId, i.skuId, take, `Avaria atingiu unidade reservada: ${i.reason}`, actor.id],
        );
        await orderEvent(c, cand.orderId, 'excecao_estoque', actor, `Avaria atingiu ${take} un. reservada(s) deste pedido.`, false);
        created.push({ id: exc!.id, orderId: cand.orderId, orderNumber: cand.number, quantity: take });
        toAllocate -= take;
      }
    }
  }
  await audit(c, actor, 'estoque.avaria', 'sku', i.skuId, { quantity: i.quantity, reason: i.reason, deficit, exceptions: created.length });
  return { movement, deficit, exceptions: created };
}

/** Descarte: sai do físico e da quarentena (o disponível não muda). */
export async function discard(c: PoolClient, actor: Actor, i: { skuId: string; quantity: number; reason: string; photoUrl?: string | null }): Promise<MoveResult> {
  const r = await move(c, {
    skuId: i.skuId,
    kind: 'descarte',
    quantity: i.quantity,
    dPhysical: -i.quantity,
    dDamaged: -i.quantity,
    reason: i.reason,
    photoUrl: i.photoUrl,
    actorId: actor.id,
  });
  await audit(c, actor, 'estoque.descarte', 'sku', i.skuId, { quantity: i.quantity, reason: i.reason });
  return r;
}

/** Recuperação: a unidade sai da quarentena e volta ao disponível. */
export async function recover(c: PoolClient, actor: Actor, i: { skuId: string; quantity: number; reason: string }): Promise<MoveResult> {
  const r = await move(c, { skuId: i.skuId, kind: 'recuperacao', quantity: i.quantity, dDamaged: -i.quantity, reason: i.reason, actorId: actor.id });
  await audit(c, actor, 'estoque.recuperacao', 'sku', i.skuId, { quantity: i.quantity, reason: i.reason });
  return r;
}

/**
 * Resolve uma exceção de estoque.
 *  - Pedido ainda não pago (avaria_reserva): só resolve quando o déficit do SKU estiver coberto (disponível ≥ 0).
 *  - Pedido pago (avaria_pedido_pago, ou avaria_reserva já paga): baixa uma unidade sadia para substituir a avariada.
 */
export async function resolveException(c: PoolClient, actor: Actor, exceptionId: string, note: string): Promise<void> {
  const ex = await q1<{ id: string; orderId: string; skuId: string; quantity: number; kind: string; status: string; number: number; reservationStatus: string; sku: string }>(
    c,
    `SELECT e.id, e.order_id, e.sku_id, e.quantity, e.kind, e.status, o.number, o.reservation_status, s.sku
       FROM order_exceptions e JOIN orders o ON o.id = e.order_id JOIN skus s ON s.id = e.sku_id
      WHERE e.id = $1 FOR UPDATE OF e`,
    [exceptionId],
  );
  if (!ex) throw notFound('Exceção não encontrada.');
  if (ex.status !== 'aberta') throw conflict('Esta exceção já foi encerrada.', 'excecao_encerrada');

  const sku = await q1<{ stockPhysical: number; stockReserved: number; stockDamaged: number }>(c, `SELECT stock_physical, stock_reserved, stock_damaged FROM skus WHERE id = $1 FOR UPDATE`, [ex.skuId]);
  if (!sku) throw notFound('SKU não encontrado.');
  const available = sku.stockPhysical - sku.stockReserved - sku.stockDamaged;

  if (ex.kind === 'avaria_reserva' && ex.reservationStatus === 'ativa') {
    if (available < 0) {
      throw conflict(`Ainda faltam ${-available} unidade(s) de ${ex.sku} para cobrir as reservas. Registre entrada de estoque ou recupere unidades.`, 'deficit_aberto', { deficit: -available });
    }
  } else {
    await move(c, {
      skuId: ex.skuId,
      kind: 'venda',
      quantity: ex.quantity,
      dPhysical: -ex.quantity,
      requireAvailable: true,
      reason: `Reposição da unidade avariada do pedido #${ex.number}`,
      orderId: ex.orderId,
      exceptionId: ex.id,
      actorId: actor.id,
      label: ex.sku,
    });
  }
  await c.query(`UPDATE order_exceptions SET status='resolvida', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1`, [ex.id, note, actor.id]);
  await orderEvent(c, ex.orderId, 'excecao_resolvida', actor, note, false);
  await audit(c, actor, 'estoque.excecao_resolvida', 'order_exception', ex.id, { orderId: ex.orderId, note });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
export async function listStock(db: Db, f: { q?: string; low?: boolean; damaged?: boolean }) {
  const params: unknown[] = [];
  const where: string[] = [`p.status <> 'arquivado' OR s.stock_physical > 0`];
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(p.name ILIKE $${params.length} OR s.sku ILIKE $${params.length} OR s.variant_name ILIKE $${params.length})`);
  }
  if (f.low) where.push(`(s.stock_physical - s.stock_reserved - s.stock_damaged) <= s.min_stock`);
  if (f.damaged) where.push(`s.stock_damaged > 0`);
  return q(
    db,
    `SELECT s.id, s.sku, s.variant_name, s.min_stock, s.active, p.id AS product_id, p.name AS product_name, p.status AS product_status,
            c.name AS category_name,
            s.stock_physical AS physical, s.stock_reserved AS reserved, s.stock_damaged AS damaged,
            (s.stock_physical - s.stock_reserved - s.stock_damaged) AS available,
            ((s.stock_physical - s.stock_reserved - s.stock_damaged) <= s.min_stock) AS low_stock,
            (SELECT COUNT(*)::int FROM order_exceptions e WHERE e.sku_id = s.id AND e.status = 'aberta') AS open_exceptions
       FROM skus s JOIN products p ON p.id = s.product_id JOIN categories c ON c.id = p.category_id
      WHERE ${where.map((w) => `(${w})`).join(' AND ')}
      ORDER BY p.name, s.variant_name`,
    params,
  );
}

export async function listMovements(db: Db, skuId: string, limit = 100) {
  return q(
    db,
    `SELECT m.id, m.kind, m.quantity, m.delta_physical, m.delta_reserved, m.delta_damaged,
            m.after_physical, m.after_reserved, m.after_damaged, m.reason, m.photo_url, m.created_at,
            COALESCE(u.name, 'Sistema') AS user_name, o.number AS order_number
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.sku_id = $1 ORDER BY m.id DESC LIMIT $2`,
    [skuId, limit],
  );
}

export async function listExceptions(db: Db, status: 'aberta' | 'todas' = 'aberta') {
  return q(
    db,
    `SELECT e.id, e.order_id, o.number AS order_number, o.fulfillment_status, e.sku_id, s.sku, p.name AS product_name, s.variant_name,
            e.quantity, e.kind, e.status, e.note, e.resolution, e.created_at, e.resolved_at,
            (s.stock_physical - s.stock_reserved - s.stock_damaged) AS sku_available
       FROM order_exceptions e
       JOIN orders o ON o.id = e.order_id
       JOIN skus s ON s.id = e.sku_id
       JOIN products p ON p.id = s.product_id
      WHERE ($1 = 'todas' OR e.status = 'aberta')
      ORDER BY e.created_at DESC LIMIT 200`,
    [status],
  );
}

/** Registra evento na linha do tempo do pedido. `publicEvent` controla se a cliente enxerga. */
export async function orderEvent(
  db: Db,
  orderId: string,
  kind: string,
  actor: Actor | null,
  note: string | null,
  publicEvent: boolean,
  fromStatus?: string | null,
  toStatus?: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO order_events (order_id, kind, from_status, to_status, actor_id, actor_name, note, public)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orderId, kind, fromStatus ?? null, toStatus ?? null, actor?.id ?? null, actor?.name ?? 'Sistema', note, publicEvent],
  );
}
