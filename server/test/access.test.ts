import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { makeSku, makeUser, PASSWORD, placeOrder, prepareDb, resetDb, pay, type TestUser } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  await prepareDb();
  app = await buildApp({ logger: false, rateLimit: false });
});
beforeEach(resetDb);

const ORIGIN = { origin: 'http://localhost:3000' };

async function login(u: TestUser): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...ORIGIN, 'content-type': 'application/json' }, payload: { email: u.email, password: PASSWORD } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((x: { name: string }) => x.name === 'maravi_session');
  expect(c).toBeTruthy();
  return `maravi_session=${c!.value}`;
}
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const post = (url: string, cookie: string | undefined, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: { ...ORIGIN, ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }, payload: payload as object | undefined });

describe('Acesso a dados de outro cliente', () => {
  it('cliente B recebe 404 ao abrir, atualizar ou cancelar o pedido do cliente A; lista só os próprios', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const { skuId } = await makeSku({ stock: 5 });
    const order = await placeOrder(a, [{ skuId, quantity: 1 }]);
    const cb = await login(b);
    expect((await get(`/api/orders/${order.id}`, cb)).statusCode).toBe(404);
    expect((await post(`/api/orders/${order.id}/refresh`, cb)).statusCode).toBe(404);
    expect((await post(`/api/orders/${order.id}/cancel`, cb)).statusCode).toBe(404);
    expect((await get('/api/orders', cb)).json().items).toHaveLength(0);
    const ca = await login(a);
    expect((await get(`/api/orders/${order.id}`, ca)).statusCode).toBe(200);
    expect((await get('/api/orders', ca)).json().items).toHaveLength(1);
  });

  it('sem sessão: 401 nas rotas do cliente e do painel', async () => {
    expect((await get('/api/orders')).statusCode).toBe(401);
    expect((await get('/api/staff/orders?view=fila')).statusCode).toBe(401);
  });

  it('cliente comum não acessa o painel (403) nem o caixa', async () => {
    const c = await makeUser();
    const cookie = await login(c);
    expect((await get('/api/staff/orders?view=fila', cookie)).statusCode).toBe(403);
    expect((await get('/api/staff/cash/summary?from=2026-01-01&to=2026-12-31', cookie)).statusCode).toBe(403);
  });

  it('Estoque não vê o caixa; Atendimento não vê o caixa; Administrador vê', async () => {
    const [est, aten, adm] = [await makeUser('estoque'), await makeUser('atendimento'), await makeUser('administrador')];
    const url = '/api/staff/cash/summary?from=2026-01-01&to=2026-12-31';
    expect((await get(url, await login(est))).statusCode).toBe(403);
    expect((await get(url, await login(aten))).statusCode).toBe(403);
    expect((await get(url, await login(adm))).statusCode).toBe(200);
  });

  it('estorno exige permissão: Atendimento recebe 403', async () => {
    const aten = await makeUser('atendimento');
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeOrder(await makeUser(), [{ skuId, quantity: 1 }]);
    await pay(o.id);
    const r = await post(`/api/staff/orders/${o.id}/refund`, await login(aten), { reason: 'Teste de permissão', restock: false });
    expect(r.statusCode).toBe(403);
  });

  it('o endpoint de simulação de pagamento responde a uma sessão de cliente só em modo simulado (e ao dono do pedido)', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const { skuId } = await makeSku({ stock: 5 });
    const o = await placeOrder(a, [{ skuId, quantity: 1 }]);
    expect((await post(`/api/dev/orders/${o.id}/simulate-payment`, await login(b))).statusCode).toBe(404);
  });

  it('requisição que altera dados com Origin desconhecida é bloqueada (CSRF)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://site-malicioso.example' } });
    expect(r.statusCode).toBe(403);
  });

  it('login com senha errada devolve 401 sem revelar se o e-mail existe', async () => {
    const u = await makeUser();
    const r1 = await post('/api/auth/login', undefined, { email: u.email, password: 'errada-errada' });
    const r2 = await post('/api/auth/login', undefined, { email: 'nao.existe@teste.local', password: 'errada-errada' });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.json().message).toBe(r2.json().message);
  });
});
