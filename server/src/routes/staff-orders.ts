import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db';
import { audit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { centsToPlain } from '../lib/money';
import { formatDateTime, localDate } from '../lib/time';
import { can } from '../lib/permissions';
import { localDateStr, parse, uuid } from '../lib/validation';
import * as cash from '../services/cash';
import { expireDueOrders } from '../services/expiry';
import * as orders from '../services/orders';
import { confirmLocalPayment } from '../services/payments';
import { dashboard } from '../services/reports';
import { actorOf, requirePermission, staffViewOf } from './guards';

const range = z.object({ from: localDateStr.optional(), to: localDateStr.optional() });
function resolveRange(r: { from?: string; to?: string }) {
  const today = localDate();
  const from = r.from ?? today;
  const to = r.to ?? from;
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function staffOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/staff/dashboard', async (req) => {
    const u = requirePermission(req, 'dashboard.view');
    return dashboard(pool, can(u.role, 'cash.view'));
  });

  // ----------------------------------------------------------- pedidos
  app.get('/staff/orders', async (req) => {
    const u = requirePermission(req, 'orders.view');
    const { view } = parse(z.object({ view: z.enum(['aguardando', 'fila', 'analise', 'excecoes', 'historico']).default('fila') }), req.query);
    return { view, items: await orders.listStaffOrders(view, staffViewOf(u)) };
  });

  // Histórico completo de pedidos por data (dia/mês/hora). Por padrão, os últimos 30 dias.
  app.get('/staff/pedidos', async (req) => {
    const u = requirePermission(req, 'orders.view');
    const r = parse(range, req.query);
    const to = r.to ?? localDate();
    const from = r.from ?? new Date(new Date(`${to}T12:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
    const f = from <= to ? { from, to } : { from: to, to: from };
    return { ...f, items: await orders.listAllStaffOrders(f.from, f.to, staffViewOf(u)) };
  });

  app.get('/staff/orders/:id', async (req) => {
    const u = requirePermission(req, 'orders.view');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const view = staffViewOf(u);
    const order = await orders.getStaffOrder(id, view);
    if (view.pii) await audit(pool, actorOf(req, u), 'pedido.ver_dados_pessoais', 'order', id, {}); // acesso a dados pessoais fica registrado
    return order;
  });

  app.post('/staff/orders/:id/advance', async (req) => {
    const u = requirePermission(req, 'orders.advance');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { to } = parse(z.object({ to: z.enum(['em_separacao', 'pronto_retirada', 'saiu_entrega', 'concluido']) }), req.body);
    await tx((c) => orders.advanceFulfillment(c, actorOf(req, u), id, to));
    return orders.getStaffOrder(id, staffViewOf(u));
  });

  // Pagamento combinado com a loja: a equipe confirma que recebeu (dinheiro, cartão, Pix direto na conta da loja...).
  app.post('/staff/orders/:id/confirm-payment', async (req) => {
    const u = requirePermission(req, 'orders.confirm_payment');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ method: z.enum(['dinheiro', 'cartao', 'pix_loja', 'outro']), note: z.string().trim().max(120).optional() }), req.body);
    await tx((c) => confirmLocalPayment(c, actorOf(req, u), id, b.method, b.note));
    return orders.getStaffOrder(id, staffViewOf(u));
  });

  app.post('/staff/orders/:id/release', async (req) => {
    const u = requirePermission(req, 'orders.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx((c) => orders.releaseFromAnalysis(c, actorOf(req, u), id));
    return orders.getStaffOrder(id, staffViewOf(u));
  });

  app.post('/staff/orders/:id/cancel', async (req) => {
    const u = requirePermission(req, 'orders.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await orders.cancelUnpaidOrder(actorOf(req, u), id);
    return orders.getStaffOrder(id, staffViewOf(u));
  });

  app.post('/staff/orders/:id/refund', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requirePermission(req, 'orders.refund');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300), restock: z.boolean().default(false) }), req.body);
    const r = await orders.requestRefund(actorOf(req, u), id, b);
    return { ...r, order: await orders.getStaffOrder(id, staffViewOf(u)) };
  });

  /** Executa agora o ciclo de vencimento (concilia antes de liberar). Também roda sozinho a cada 30 s. */
  app.post('/staff/jobs/expire', async (req) => {
    requirePermission(req, 'orders.review');
    return expireDueOrders();
  });

  // ------------------------------------------------------------- caixa
  app.get('/staff/cash/summary', async (req) => {
    requirePermission(req, 'cash.view');
    const r = resolveRange(parse(range, req.query));
    return cash.cashSummary(pool, r.from, r.to);
  });

  const statementQuery = range.extend({
    kind: z.enum(['recebimento', 'estorno', 'saida']).optional(),
    order: z.coerce.number().int().positive().optional(),
  });

  app.get('/staff/cash/statement', async (req) => {
    requirePermission(req, 'cash.view');
    const f = parse(statementQuery, req.query);
    const r = resolveRange(f);
    return { ...r, items: await cash.cashStatement(pool, r.from, r.to, { kind: f.kind, orderNumber: f.order }) };
  });

  app.get('/staff/cash/statement.csv', async (req, reply) => {
    const u = requirePermission(req, 'cash.view');
    const f = parse(statementQuery, req.query);
    const r = resolveRange(f);
    const rows = await cash.cashStatement(pool, r.from, r.to, { kind: f.kind, orderNumber: f.order });
    await audit(pool, actorOf(req, u), 'caixa.exportar_csv', 'cash', null, { ...r, linhas: rows.length });
    const label: Record<string, string> = { recebimento: 'Recebimento Pix', estorno: 'Estorno', saida: 'Saída autorizada' };
    const csv = toCsv(rows, [
      { header: 'Data/hora (São Luís)', value: (x) => formatDateTime(x.occurredAt), trusted: true },
      { header: 'Tipo', value: (x) => label[x.kind as string] ?? x.kind, trusted: true },
      { header: 'Pedido', value: (x) => x.orderNumber, trusted: true },
      { header: 'Descrição', value: (x) => x.description },
      { header: 'Bruto (R$)', value: (x) => centsToPlain(x.grossCents), trusted: true },
      { header: 'Frete (R$)', value: (x) => centsToPlain(x.shippingCents), trusted: true },
      { header: 'Desconto (R$)', value: (x) => centsToPlain(x.discountCents), trusted: true },
      { header: 'Taxa (R$)', value: (x) => centsToPlain(x.feeCents), trusted: true },
      { header: 'Movimento líquido do app (R$)', value: (x) => centsToPlain(x.movementCents), trusted: true },
      { header: 'Registrado por', value: (x) => x.createdByName },
      { header: 'Autorizado por', value: (x) => x.authorizedByName },
    ]);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="caixa-${r.from}_${r.to}.csv"`)
      .send(csv);
  });

  app.get('/staff/cash/reconciliation', async (req) => {
    requirePermission(req, 'cash.view');
    const r = resolveRange(parse(range, req.query));
    return cash.reconciliation(r.from, r.to);
  });

  app.post('/staff/cash/outflows', async (req, reply) => {
    const u = requirePermission(req, 'cash.manage');
    const b = parse(z.object({ amountCents: z.number().int().min(1).max(10_000_000), description: z.string().trim().min(3).max(200) }), req.body);
    const row = await tx((c) => cash.recordOutflow(c, actorOf(req, u), b));
    return reply.code(201).send(row);
  });
}
