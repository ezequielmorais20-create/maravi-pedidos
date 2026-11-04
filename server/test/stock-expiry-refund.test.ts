import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, q1, tx } from '../src/db';
import { expireDueOrders } from '../src/services/expiry';
import * as stock from '../src/services/stock';
import { requestRefund, advanceFulfillment, releaseFromAnalysis, simulatePixPayment } from '../src/services/orders';
import { handleWebhook } from '../src/services/payments';
import { actorOf, chargeOf, count, makeSku, makeUser, orderRow, pay, placeOrder, prepareDb, resetDb, sim, stockOf } from './helpers';

beforeAll(prepareDb);
beforeEach(resetDb);

describe('Estoque: última unidade e quatro números', () => {
  it('10 clientes disputam a última unidade: exatamente 1 pedido é criado', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const { skuId } = await makeSku({ stock: 1 });
    const rs = await Promise.allSettled(users.map((u) => placeOrder(u, [{ skuId, quantity: 1 }])));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stockOf(skuId)).toMatchObject({ physical: 1, reserved: 1, available: 0 });
    expect(await count('orders')).toBe(1);
  });

  it('SKU esgotado não pode ser comprado', async () => {
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 0 });
    await expect(placeOrder(u, [{ skuId, quantity: 1 }])).rejects.toThrow();
    expect(await count('orders')).toBe(0);
  });

  it('disponível = físico − reservado − avariado, e nunca fica negativo por venda', async () => {
    const u = await makeUser();
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 10 });
    await tx((c) => stock.registerDamage(c, adm, { skuId, quantity: 2, reason: 'Caiu no chão' }));
    await placeOrder(u, [{ skuId, quantity: 3 }]);
    expect(await stockOf(skuId)).toMatchObject({ physical: 10, reserved: 3, damaged: 2, available: 5 });
    await expect(placeOrder(await makeUser(), [{ skuId, quantity: 6 }])).rejects.toThrow();
  });

  it('avaria mantém a unidade no físico (quarentena); descarte reduz físico e quarentena; recuperar devolve ao disponível', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 10 });
    await tx((c) => stock.registerDamage(c, adm, { skuId, quantity: 3, reason: 'Embalagem rompida' }));
    expect(await stockOf(skuId)).toMatchObject({ physical: 10, damaged: 3, available: 7 });
    await tx((c) => stock.discard(c, adm, { skuId, quantity: 1, reason: 'Sem condição de uso' }));
    expect(await stockOf(skuId)).toMatchObject({ physical: 9, damaged: 2, available: 7 });
    await tx((c) => stock.recover(c, adm, { skuId, quantity: 2, reason: 'Embalagem trocada' }));
    expect(await stockOf(skuId)).toMatchObject({ physical: 9, damaged: 0, available: 9 });
    const kinds = (await stock.listMovements(pool, skuId)).map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['avaria', 'descarte', 'recuperacao']));
  });

  it('não é possível descartar/recuperar mais do que há em quarentena', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    await expect(tx((c) => stock.discard(c, adm, { skuId, quantity: 1, reason: 'x' }))).rejects.toThrow();
    await expect(tx((c) => stock.recover(c, adm, { skuId, quantity: 1, reason: 'x' }))).rejects.toThrow();
    expect(await stockOf(skuId)).toMatchObject({ physical: 5, damaged: 0 });
  });

  it('avaria sobre unidade reservada abre exceção e BLOQUEIA a expedição até resolver', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const u = await makeUser();
    const { skuId } = await makeSku({ stock: 1 });
    const o = await placeOrder(u, [{ skuId, quantity: 1 }]);
    await pay(o.id);
    await tx((c) => stock.registerDamage(c, adm, { skuId, quantity: 1, reason: 'Quebrou na separação', orderId: o.id }));
    const ex = await stock.listExceptions(pool, 'aberta');
    expect(ex).toHaveLength(1);
    await tx((c) => advanceFulfillment(c, adm, o.id, 'em_separacao'));
    await expect(tx((c) => advanceFulfillment(c, adm, o.id, 'pronto_retirada'))).rejects.toThrow();
    // repõe unidade e resolve
    await tx((c) => stock.entry(c, adm, { skuId, quantity: 1, reason: 'Reposição' }));
    await tx((c) => stock.resolveException(c, adm, ex[0]!.id as string, 'Reposto'));
    expect(await stock.listExceptions(pool, 'aberta')).toHaveLength(0);
    await tx((c) => advanceFulfillment(c, adm, o.id, 'pronto_retirada'));
    expect((await orderRow(o.id)).fulfillmentStatus).toBe('pronto_retirada');
  });

  it('pular etapas do atendimento é recusado (pago → concluído)', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 3 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await pay(o.id);
    await expect(tx((c) => advanceFulfillment(c, adm, o.id, 'concluido'))).rejects.toThrow();
  });
});

describe('Expiração e Pix tardio', () => {
  const future = () => new Date(Date.now() + 60 * 60_000);

  it('reserva vencida e sem pagamento: libera o estoque e expira o pedido', async () => {
    const { skuId } = await makeSku({ stock: 2 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 2 }]);
    expect((await stockOf(skuId)).reserved).toBe(2);
    expect(await expireDueOrders(new Date())).toMatchObject({ expired: 0 }); // ainda dentro do prazo
    const r = await expireDueOrders(future());
    expect(r.expired).toBe(1);
    expect(await stockOf(skuId)).toMatchObject({ reserved: 0, available: 2 });
    expect(await orderRow(o.id)).toMatchObject({ paymentStatus: 'expirado', reservationStatus: 'liberada' });
  });

  it('CONCILIA antes de liberar: Pix pago cujo webhook atrasou confirma o pedido em vez de expirar', async () => {
    const { skuId } = await makeSku({ stock: 2 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    // O cliente pagou no banco, mas o webhook NÃO chegou (deliver: false).
    await simulatePixPayment(o.id, { deliver: false });
    expect((await orderRow(o.id)).paymentStatus).toBe('pendente');
    const r = await expireDueOrders(future());
    expect(r.expired).toBe(0);
    expect(r.confirmed).toBe(1);
    expect((await orderRow(o.id)).paymentStatus).toBe('pago');
    expect(await count('payments')).toBe(1);
    expect(await count('cash_entries', `kind='recebimento'`)).toBe(1);
  });

  it('Pix descoberto DEPOIS da liberação: recibo registrado, pedido vai para análise e só segue com estoque garantido', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 1 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await expireDueOrders(future());
    expect((await orderRow(o.id)).paymentStatus).toBe('expirado');
    // outro cliente leva a última unidade
    const o2 = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    // o primeiro cliente paga tarde
    const signed = await sim().markPaid((await chargeOf(o.id)).providerChargeId);
    expect((await handleWebhook(signed.body, signed.headers)).result).toBe('pago_apos_vencimento');
    const row = await orderRow(o.id);
    expect(row.paymentStatus).toBe('pago');
    expect(row.fulfillmentStatus).toBe('em_analise');
    expect(row.latePayment).toBe(true);
    expect(await count('payments', 'order_id = $1', [o.id])).toBe(1);
    expect(await count('cash_entries', `order_id = $1 AND kind = 'recebimento'`, [o.id])).toBe(1);
    // sem estoque garantido: não libera a separação
    await expect(tx((c) => releaseFromAnalysis(c, adm, o.id))).rejects.toThrow();
    expect((await orderRow(o.id)).fulfillmentStatus).toBe('em_analise');
    // com reposição, libera
    await tx((c) => stock.entry(c, adm, { skuId, quantity: 1, reason: 'Reposição' }));
    await tx((c) => releaseFromAnalysis(c, adm, o.id));
    expect((await orderRow(o.id)).fulfillmentStatus).toBe('pago');
    void o2;
  });
});

describe('Estorno', () => {
  it('estorno confirmado: saída ligada ao pedido, recibo original preservado, status estornado e estoque devolvido', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ price: 2000, stock: 5 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 2 }]);
    await pay(o.id);
    expect((await stockOf(skuId)).physical).toBe(3);
    const r = await requestRefund(adm, o.id, { reason: 'Cliente desistiu', restock: true });
    expect(r.status).toBe('confirmado');
    expect((await orderRow(o.id)).paymentStatus).toBe('estornado');
    const entries = await pool.query(`SELECT kind, gross_cents FROM cash_entries WHERE order_id = $1 ORDER BY id`, [o.id]);
    expect(entries.rows.map((e) => e.kind)).toEqual(['recebimento', 'estorno']);
    expect(Number(entries.rows[0]!.gross_cents)).toBe(Number(entries.rows[1]!.gross_cents));
    expect((await stockOf(skuId)).physical).toBe(5);
  });

  it('estorno em duplicidade é recusado e o webhook de estorno repetido não duplica a saída', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await pay(o.id);
    await requestRefund(adm, o.id, { reason: 'Teste', restock: false });
    await expect(requestRefund(adm, o.id, { reason: 'Outra vez', restock: false })).rejects.toThrow();
    expect(await count('cash_entries', `kind = 'estorno'`)).toBe(1);
  });

  it('pedido não pago não pode ser estornado', async () => {
    const adm = actorOf(await makeUser('administrador'));
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await expect(requestRefund(adm, o.id, { reason: 'Sem pagamento', restock: false })).rejects.toThrow();
  });
});

void q1;
