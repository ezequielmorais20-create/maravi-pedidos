import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool, tx } from '../src/db';
import { expireDueOrders } from '../src/services/expiry';
import { confirmLocalPayment } from '../src/services/payments';
import { createCheckout, listStaffOrders, requestRefund } from '../src/services/orders';
import { asCustomer, actorOf, count, makeSku, makeUser, orderRow, PASSWORD, placeOrder, prepareDb, resetDb, stockOf, type TestUser } from './helpers';

let seq = 0;
const placeLocal = (u: TestUser, items: { skuId: string; quantity: number }[], mode: 'retirada' | 'entrega' = 'retirada') =>
  createCheckout(asCustomer(u), { items, deliveryMode: mode, paymentMethod: 'local', idempotencyKey: `local-${++seq}-${Math.random().toString(36).slice(2)}` });

beforeAll(prepareDb);
beforeEach(resetDb);

describe('Pagamento combinado com a loja', () => {
  it('cria o pedido, reserva o estoque, não gera cobrança Pix e não aplica desconto Pix', async () => {
    await pool.query(`UPDATE settings SET value = '10' WHERE key = 'desconto_pix_percent'`);
    const u = await makeUser();
    const { skuId } = await makeSku({ price: 1500, stock: 5 });
    const o = await placeLocal(u, [{ skuId, quantity: 2 }]);
    expect(o.paymentMethod).toBe('local');
    expect(o.discountCents).toBe(0);
    expect(o.totalCents).toBe(3000);
    expect(o.pix).toBeNull();
    expect(await count('pix_charges')).toBe(0);
    expect(await stockOf(skuId)).toMatchObject({ physical: 5, reserved: 2, available: 3 });
    expect((await orderRow(o.id)).paymentStatus).toBe('pendente');
  });

  it('a equipe confirma o recebimento: pagamento, baixa e caixa uma única vez', async () => {
    const adm = actorOf(await makeUser('atendimento'));
    const { skuId } = await makeSku({ price: 1500, stock: 5 });
    const o = await placeLocal(await makeUser(), [{ skuId, quantity: 1 }]);
    await tx((c) => confirmLocalPayment(c, adm, o.id, 'dinheiro'));
    expect((await orderRow(o.id)).paymentStatus).toBe('pago');
    expect(await stockOf(skuId)).toMatchObject({ physical: 4, reserved: 0 });
    expect(await count('payments', `method = 'dinheiro'`)).toBe(1);
    expect(await count('cash_entries', `kind = 'recebimento'`)).toBe(1);
    // segunda confirmação (duplo clique): recusada, nada duplica
    await expect(tx((c) => confirmLocalPayment(c, adm, o.id, 'dinheiro'))).rejects.toThrow();
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries')).toBe(1);
    expect((await stockOf(skuId)).physical).toBe(4);
    const fila = await listStaffOrders('fila', { pii: true, totals: true });
    expect(fila.map((x) => x.number)).toEqual([o.number]);
  });

  it('confirmações simultâneas: só uma vale', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeLocal(await makeUser(), [{ skuId, quantity: 1 }]);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => tx((c) => confirmLocalPayment(c, adm, o.id, 'cartao'))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries')).toBe(1);
  });

  it('pedido de Pix não pode ser confirmado à mão', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await expect(tx((c) => confirmLocalPayment(c, adm, o.id, 'dinheiro'))).rejects.toThrow();
    expect(await count('payments')).toBe(0);
  });

  it('reserva vencida: libera o estoque sem provedor e não aceita confirmação', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 2 });
    const o = await placeLocal(await makeUser(), [{ skuId, quantity: 2 }]);
    await pool.query(`UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [o.id]);
    await expect(tx((c) => confirmLocalPayment(c, adm, o.id, 'dinheiro'))).rejects.toThrow();
    const r = await expireDueOrders(new Date());
    expect(r.expired).toBe(1);
    expect(await stockOf(skuId)).toMatchObject({ reserved: 0, available: 2 });
    expect((await orderRow(o.id)).paymentStatus).toBe('expirado');
  });

  it('devolução de pagamento local: saída ligada ao pedido, recibo preservado e estoque devolvido', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeLocal(await makeUser(), [{ skuId, quantity: 2 }]);
    await tx((c) => confirmLocalPayment(c, adm, o.id, 'pix_loja'));
    const r = await requestRefund(adm, o.id, { reason: 'Cliente desistiu', restock: true });
    expect(r.status).toBe('confirmado');
    expect((await orderRow(o.id)).paymentStatus).toBe('estornado');
    const kinds = await pool.query(`SELECT kind FROM cash_entries WHERE order_id = $1 ORDER BY id`, [o.id]);
    expect(kinds.rows.map((x: { kind: string }) => x.kind)).toEqual(['recebimento', 'estorno']);
    expect((await stockOf(skuId)).physical).toBe(5);
  });
});

describe('Permissão para confirmar pagamento (HTTP)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp({ logger: false, rateLimit: false }); });
  const login = async (u: TestUser) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, payload: { email: u.email, password: PASSWORD } });
    return `maravi_session=${r.cookies.find((x: { name: string }) => x.name === 'maravi_session')!.value}`;
  };
  const confirm = (id: string, cookie: string) =>
    app.inject({ method: 'POST', url: `/api/staff/orders/${id}/confirm-payment`, headers: { origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' }, payload: { method: 'dinheiro' } });

  it('Estoque e cliente recebem 403; Atendimento confirma', async () => {
    const { skuId } = await makeSku({ stock: 5 });
    const cli = await makeUser();
    const o = await placeLocal(cli, [{ skuId, quantity: 1 }]);
    expect((await confirm(o.id, await login(await makeUser('estoque')))).statusCode).toBe(403);
    expect((await confirm(o.id, await login(cli))).statusCode).toBe(403);
    expect((await confirm(o.id, await login(await makeUser('atendimento')))).statusCode).toBe(200);
  });
});
