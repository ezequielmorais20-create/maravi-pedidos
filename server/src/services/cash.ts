import type { PoolClient } from 'pg';
import { pool, q, q1, type Db } from '../db';
import { audit, type Actor } from '../lib/audit';
import { getPixProvider } from '../pix';

const LOCAL_RANGE = `(e.occurred_at AT TIME ZONE 'America/Fortaleza')::date BETWEEN $1::date AND $2::date`;

export const CASH_NOTE =
  'Movimento líquido do aplicativo = recebimentos brutos − taxas − estornos − saídas autorizadas. ' +
  'Não é saldo bancário nem lucro: não considera custo das mercadorias, despesas, tarifas fora do Pix nem repasses pendentes do provedor.';

export async function cashSummary(db: Db, from: string, to: string) {
  const r = await q1<Record<string, number>>(
    db,
    `SELECT
        COALESCE(SUM(e.gross_cents)    FILTER (WHERE e.kind = 'recebimento'),0)::int AS recebimentos_brutos_cents,
        COALESCE(SUM(e.shipping_cents) FILTER (WHERE e.kind = 'recebimento'),0)::int AS frete_cents,
        COALESCE(SUM(e.discount_cents) FILTER (WHERE e.kind = 'recebimento'),0)::int AS descontos_cents,
        COALESCE(SUM(e.fee_cents)      FILTER (WHERE e.kind = 'recebimento'),0)::int AS taxas_cents,
        COALESCE(SUM(e.gross_cents)    FILTER (WHERE e.kind = 'estorno'),0)::int     AS estornos_cents,
        COALESCE(SUM(e.gross_cents)    FILTER (WHERE e.kind = 'saida'),0)::int       AS saidas_cents,
        COUNT(*) FILTER (WHERE e.kind = 'recebimento')::int                          AS recebimentos_qtd
       FROM cash_entries e WHERE ${LOCAL_RANGE}`,
    [from, to],
  );
  const s = r!;
  return {
    from,
    to,
    recebimentosBrutosCents: s.recebimentosBrutosCents,
    freteCents: s.freteCents, // parcela de frete dentro dos recebimentos brutos
    descontosCents: s.descontosCents, // descontos já abatidos dos totais recebidos (informativo)
    taxasCents: s.taxasCents,
    estornosCents: s.estornosCents,
    saidasCents: s.saidasCents,
    recebimentosQtd: s.recebimentosQtd,
    movimentoLiquidoAppCents: s.recebimentosBrutosCents - s.taxasCents - s.estornosCents - s.saidasCents,
    nota: CASH_NOTE,
  };
}

export async function cashStatement(db: Db, from: string, to: string, opts: { kind?: string; orderNumber?: number } = {}) {
  const params: unknown[] = [from, to];
  let extra = '';
  if (opts.kind) {
    params.push(opts.kind);
    extra += ` AND e.kind = $${params.length}`;
  }
  if (opts.orderNumber) {
    params.push(opts.orderNumber);
    extra += ` AND o.number = $${params.length}`;
  }
  return q(
    db,
    `SELECT e.id, e.kind, e.occurred_at, e.description, o.number AS order_number,
            e.gross_cents, e.shipping_cents, e.discount_cents, e.fee_cents,
            CASE e.kind WHEN 'recebimento' THEN e.gross_cents - e.fee_cents ELSE -e.gross_cents END AS movement_cents,
            cu.name AS created_by_name, au.name AS authorized_by_name
       FROM cash_entries e
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users cu ON cu.id = e.created_by
       LEFT JOIN users au ON au.id = e.authorized_by
      WHERE ${LOCAL_RANGE}${extra}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT 2000`,
    params,
  );
}

/** Saída autorizada manualmente (ex.: troco de entregador, reembolso em dinheiro). Somente administradores. */
export async function recordOutflow(c: PoolClient, actor: Actor, i: { amountCents: number; description: string; occurredAt?: Date }) {
  const row = await q1<{ id: number }>(
    c,
    `INSERT INTO cash_entries (kind, gross_cents, description, occurred_at, created_by, authorized_by)
     VALUES ('saida',$1,$2,$3,$4,$4) RETURNING id`,
    [i.amountCents, i.description, i.occurredAt ?? new Date(), actor.id],
  );
  await audit(c, actor, 'caixa.saida', 'cash_entry', row!.id, { amountCents: i.amountCents, description: i.description });
  return row!;
}

const dayStart = (d: string) => new Date(`${d}T00:00:00-03:00`); // São Luís: UTC−3 fixo (sem horário de verão)
const dayAfter = (d: string) => new Date(dayStart(d).getTime() + 24 * 3600 * 1000);

export type ReconStatus = 'ok' | 'so_no_provedor' | 'so_no_app' | 'valor_diferente';

/** Conciliação: compara as liquidações informadas pelo provedor com os pagamentos registrados no app. */
export async function reconciliation(from: string, to: string) {
  const start = dayStart(from);
  const end = dayAfter(to);
  const app = await q<{ providerChargeId: string; orderNumber: number; amountCents: number; settledAt: Date }>(
    pool,
    `SELECT c.provider_charge_id, o.number AS order_number, p.amount_cents, p.settled_at
       FROM payments p JOIN pix_charges c ON c.id = p.charge_id JOIN orders o ON o.id = p.order_id
      WHERE p.settled_at >= $1 AND p.settled_at < $2 ORDER BY p.settled_at`,
    [start, end],
  );

  let providerAvailable = true;
  let providerRows: { providerChargeId: string; amountCents: number; settledAt: Date }[] = [];
  try {
    providerRows = await getPixProvider().listSettlements(start, end);
  } catch {
    providerAvailable = false;
  }

  const appBy = new Map(app.map((a) => [a.providerChargeId, a]));
  const provBy = new Map(providerRows.map((p) => [p.providerChargeId, p]));
  const items: { providerChargeId: string; orderNumber: number | null; providerAmountCents: number | null; appAmountCents: number | null; settledAt: Date; status: ReconStatus }[] = [];
  for (const p of providerRows) {
    const a = appBy.get(p.providerChargeId);
    items.push({
      providerChargeId: p.providerChargeId,
      orderNumber: a?.orderNumber ?? null,
      providerAmountCents: p.amountCents,
      appAmountCents: a?.amountCents ?? null,
      settledAt: p.settledAt,
      status: !a ? 'so_no_provedor' : a.amountCents === p.amountCents ? 'ok' : 'valor_diferente',
    });
  }
  if (providerAvailable) {
    for (const a of app) {
      if (!provBy.has(a.providerChargeId)) {
        items.push({ providerChargeId: a.providerChargeId, orderNumber: a.orderNumber, providerAmountCents: null, appAmountCents: a.amountCents, settledAt: a.settledAt, status: 'so_no_app' });
      }
    }
  }
  const rejectedEvents = await q(
    pool,
    `SELECT id, provider, event_id, type, provider_charge_id, result, received_at
       FROM provider_events
      WHERE received_at >= $1 AND received_at < $2
        AND (result LIKE 'rejeitado%' OR result IN ('cobranca_desconhecida','estorno_desconhecido','status_ignorado','ignorado_estado_pedido'))
      ORDER BY id DESC LIMIT 200`,
    [start, end],
  );
  const lateOrders = await q(
    pool,
    `SELECT number, total_cents, paid_at, fulfillment_status FROM orders WHERE late_payment AND paid_at >= $1 AND paid_at < $2 ORDER BY paid_at`,
    [start, end],
  );
  return {
    from,
    to,
    providerAvailable,
    providerTotalCents: providerRows.reduce((s, r) => s + r.amountCents, 0),
    appTotalCents: app.reduce((s, r) => s + r.amountCents, 0),
    divergences: items.filter((i) => i.status !== 'ok').length,
    items: items.sort((a, b) => a.settledAt.getTime() - b.settledAt.getTime()),
    rejectedEvents,
    lateOrders,
  };
}
