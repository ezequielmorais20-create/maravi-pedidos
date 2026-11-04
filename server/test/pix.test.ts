import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, q } from '../src/db';
import { buildApp } from '../src/app';
import { handleWebhook } from '../src/services/payments';
import { listStaffOrders, refreshCustomerPayment } from '../src/services/orders';
import { asCustomer, chargeOf, count, makeSku, makeUser, orderRow, placeOrder, pay, prepareDb, resetDb, sim, stockOf } from './helpers';

beforeAll(prepareDb);
beforeEach(resetDb);

describe('Pix: confirmação autenticada e idempotente', () => {
  it('o mesmo evento reenviado 3 vezes gera 1 pagamento, 1 lançamento no caixa e 1 baixa de estoque', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ price: 1500, stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 2 }]);
    const ch = await chargeOf(order.id);
    const signed = await sim().markPaid(ch.providerChargeId, { eventId: 'evt-fixo-1' });

    const results = [];
    for (let i = 0; i < 3; i++) results.push((await handleWebhook(signed.body, signed.headers)).result);

    expect(results).toEqual(['confirmado', 'duplicado', 'duplicado']);
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries', `kind = 'recebimento'`)).toBe(1);
    expect(await count('stock_movements', `kind = 'venda'`)).toBe(1);
    expect(await stockOf(skuId)).toMatchObject({ physical: 3, reserved: 0, available: 3 });
    expect((await orderRow(order.id)).paymentStatus).toBe('pago');
  });

  it('eventos com ids diferentes para a MESMA cobrança também não duplicam', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const ch = await chargeOf(order.id);
    const e1 = await sim().markPaid(ch.providerChargeId, { eventId: 'evt-A' });
    const e2 = await sim().markPaid(ch.providerChargeId, { eventId: 'evt-B' });
    expect((await handleWebhook(e1.body, e1.headers)).result).toBe('confirmado');
    expect((await handleWebhook(e2.body, e2.headers)).result).toBe('duplicado_cobranca');
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries', `kind = 'recebimento'`)).toBe(1);
    expect((await stockOf(skuId)).physical).toBe(4);
  });

  it('entregas SIMULTÂNEAS do mesmo evento: apenas uma confirma', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const signed = await sim().markPaid((await chargeOf(order.id)).providerChargeId, { eventId: 'evt-concorrente' });
    const rs = await Promise.all(Array.from({ length: 6 }, () => handleWebhook(signed.body, signed.headers)));
    expect(rs.filter((r) => r.result === 'confirmado')).toHaveLength(1);
    expect(rs.filter((r) => r.result === 'duplicado')).toHaveLength(5);
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries')).toBe(1);
    expect((await stockOf(skuId)).physical).toBe(4);
  });

  it('assinatura inválida ou ausente é rejeitada (401) e nada muda', async () => {
    const app = await buildApp({ logger: false, rateLimit: false });
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const signed = await sim().markPaid((await chargeOf(order.id)).providerChargeId);

    const bad = await app.inject({ method: 'POST', url: '/api/webhooks/pix', headers: { 'content-type': 'application/json', 'x-maravi-signature': 'a'.repeat(64) }, payload: signed.body });
    expect(bad.statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/api/webhooks/pix', headers: { 'content-type': 'application/json' }, payload: signed.body });
    expect(none.statusCode).toBe(401);
    // corpo adulterado com a assinatura original
    const tampered = Buffer.from(signed.body.toString().replace('"fee_cents":0', '"fee_cents":1'));
    const t = await app.inject({ method: 'POST', url: '/api/webhooks/pix', headers: signed.headers, payload: tampered });
    expect(t.statusCode).toBe(401);

    expect((await orderRow(order.id)).paymentStatus).toBe('pendente');
    expect(await count('payments')).toBe(0);

    const ok = await app.inject({ method: 'POST', url: '/api/webhooks/pix', headers: signed.headers, payload: signed.body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result).toBe('confirmado');
    await app.close();
  });

  it('valor divergente é rejeitado: o pedido continua aguardando e nada entra no caixa', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ price: 1500, stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const signed = await sim().markPaid((await chargeOf(order.id)).providerChargeId, { amountCents: 100 });
    expect((await handleWebhook(signed.body, signed.headers)).result).toBe('rejeitado_valor');
    expect((await orderRow(order.id)).paymentStatus).toBe('pendente');
    expect(await count('payments')).toBe(0);
    expect(await count('cash_entries')).toBe(0);
    expect((await stockOf(skuId)).reserved).toBe(1);
  });

  it('status diferente de CONCLUIDA e cobrança desconhecida não confirmam nada', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const ch = await chargeOf(order.id);
    const ativa = sim().sign({ id: 'evt-ativa', type: 'pix.paid', charge_id: ch.providerChargeId, amount_cents: 1500, status: 'ATIVA', settled_at: new Date().toISOString(), fee_cents: 0 });
    expect((await handleWebhook(ativa.body, ativa.headers)).result).toBe('status_ignorado');
    const desc = sim().sign({ id: 'evt-x', type: 'pix.paid', charge_id: 'NAOEXISTE', amount_cents: 1500, status: 'CONCLUIDA', settled_at: new Date().toISOString(), fee_cents: 0 });
    expect((await handleWebhook(desc.body, desc.headers)).result).toBe('cobranca_desconhecida');
    expect((await orderRow(order.id)).paymentStatus).toBe('pendente');
  });

  it('o cliente NÃO confirma o próprio pedido: "atualizar" só confirma se o provedor informar pagamento', async () => {
    const app = await buildApp({ logger: false, rateLimit: false });
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(u, [{ skuId, quantity: 1 }]);
    const after = await refreshCustomerPayment(u.id, order.id);
    expect(after.paymentStatus).toBe('pendente');
    expect(await count('payments')).toBe(0);
    await app.close();
  });
});

describe('Fila de pedidos pelo horário de liquidação', () => {
  const view = { pii: true, totals: true };

  it('Pix liquidado primeiro aparece antes, mesmo que o pedido tenha sido criado depois', async () => {
    const [c1, c2] = [await makeUser(), await makeUser()];
    const { skuId } = await makeSku({ stock: 10 });
    const a = await placeOrder(c1, [{ skuId, quantity: 1 }]); // criado primeiro
    const b = await placeOrder(c2, [{ skuId, quantity: 1 }]); // criado depois
    const now = Date.now();
    await pay(a.id, new Date(now - 5 * 60_000)); // A liquidou às 12:55
    await pay(b.id, new Date(now - 10 * 60_000)); // B liquidou às 12:50 => primeiro
    const fila = await listStaffOrders('fila', view);
    expect(fila.map((o) => o.number)).toEqual([b.number, a.number]);
  });

  it('empate de horário: desempate estável pelo número do pedido', async () => {
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const { skuId } = await makeSku({ stock: 10 });
    const os = [];
    for (const u of users) os.push(await placeOrder(u, [{ skuId, quantity: 1 }]));
    const same = new Date(Date.now() - 60_000);
    for (const o of [os[2]!, os[0]!, os[1]!]) await pay(o.id, same); // pagos fora de ordem, mesmo horário
    const fila = await listStaffOrders('fila', view);
    expect(fila.map((o) => o.number)).toEqual(os.map((o) => o.number));
    // repetir a consulta devolve exatamente a mesma ordem
    expect((await listStaffOrders('fila', view)).map((o) => o.number)).toEqual(os.map((o) => o.number));
  });

  it('pedidos aguardando Pix ficam fora da fila de separação', async () => {
    const [c1, c2] = [await makeUser(), await makeUser()];
    const { skuId } = await makeSku({ stock: 10 });
    const paid = await placeOrder(c1, [{ skuId, quantity: 1 }]);
    const waiting = await placeOrder(c2, [{ skuId, quantity: 1 }]);
    await pay(paid.id);
    expect((await listStaffOrders('fila', view)).map((o) => o.number)).toEqual([paid.number]);
    expect((await listStaffOrders('aguardando', view)).map((o) => o.number)).toEqual([waiting.number]);
  });

  it('a fila usa o horário do provedor (paid_at), não o horário em que o app recebeu o evento', async () => {
    const [c1, c2] = [await makeUser(), await makeUser()];
    const { skuId } = await makeSku({ stock: 10 });
    const a = await placeOrder(c1, [{ skuId, quantity: 1 }]);
    const b = await placeOrder(c2, [{ skuId, quantity: 1 }]);
    await pay(a.id, new Date(Date.now() - 2 * 60_000)); // app recebe A primeiro...
    await pay(b.id, new Date(Date.now() - 30 * 60_000)); // ...mas B liquidou há 30 min
    const rows = await q(pool, `SELECT o.number, p.settled_at, p.received_at FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.id`);
    expect(rows[0]!.number).toBe(a.number); // recebido primeiro
    expect((await listStaffOrders('fila', view))[0]!.number).toBe(b.number); // mas fica atrás na fila
  });
});

void asCustomer;
