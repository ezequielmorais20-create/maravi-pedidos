import { q1, type Db } from '../db';

/** Contagens operacionais para a Visão geral. Valores financeiros só entram quando `finance` é true. */
export async function dashboard(db: Db, finance: boolean) {
  const base = await q1<Record<string, number>>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE payment_status = 'pendente')::int AS aguardando_pix,
       (SELECT COUNT(*) FROM orders WHERE payment_status = 'pago' AND fulfillment_status IN ('pago'))::int AS na_fila,
       (SELECT COUNT(*) FROM orders WHERE fulfillment_status IN ('em_separacao'))::int AS em_separacao,
       (SELECT COUNT(*) FROM orders WHERE fulfillment_status IN ('pronto_retirada','saiu_entrega'))::int AS prontos_ou_em_rota,
       (SELECT COUNT(*) FROM orders WHERE fulfillment_status = 'em_analise')::int AS em_analise,
       (SELECT COUNT(*) FROM order_exceptions WHERE status = 'aberta')::int AS excecoes_abertas,
       (SELECT COUNT(*) FROM skus s JOIN products p ON p.id = s.product_id
         WHERE s.active AND p.status = 'publicado' AND (s.stock_physical - s.stock_reserved - s.stock_damaged) <= s.min_stock)::int AS estoque_baixo,
       (SELECT COALESCE(SUM(stock_damaged),0) FROM skus)::int AS unidades_em_quarentena,
       (SELECT COUNT(*) FROM orders
         WHERE payment_status = 'pago' AND (paid_at AT TIME ZONE 'America/Fortaleza')::date = (now() AT TIME ZONE 'America/Fortaleza')::date)::int AS pagos_hoje`,
  );
  if (!finance) return base!;
  const money = await q1<Record<string, number>>(
    db,
    `SELECT
       COALESCE(SUM(gross_cents) FILTER (WHERE kind = 'recebimento'),0)::int AS recebimentos_hoje_cents,
       COALESCE(SUM(CASE kind WHEN 'recebimento' THEN gross_cents - fee_cents ELSE -gross_cents END),0)::int AS movimento_liquido_hoje_cents
       FROM cash_entries
      WHERE (occurred_at AT TIME ZONE 'America/Fortaleza')::date = (now() AT TIME ZONE 'America/Fortaleza')::date`,
  );
  return { ...base!, ...money! };
}
