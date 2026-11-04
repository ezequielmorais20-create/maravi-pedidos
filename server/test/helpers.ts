import { pool, q1 } from '../src/db';
import type { Actor } from '../src/lib/audit';
import { hashPassword } from '../src/lib/security';
import { runMigrations } from '../src/migrate';
import { getSimulatedProvider } from '../src/pix';
import * as orders from '../src/services/orders';

export const PASSWORD = 'Senha@12345';
let pwHash: string | null = null;
let seq = 0;

export async function prepareDb(): Promise<void> {
  await runMigrations();
}

/** Limpa dados operacionais e restaura as configurações padrão da loja. */
export async function resetDb(): Promise<void> {
  await pool.query(`TRUNCATE order_exceptions, stock_movements, cash_entries, refunds, payments, provider_events, pix_charges, order_events, order_items, orders,
    sku_price_history, skus, product_images, products, categories, addresses, password_resets, sessions, outbox_emails, audit_log, pix_simulator_charges RESTART IDENTITY`);
  await pool.query(`UPDATE settings SET updated_by = NULL`);
  await pool.query(`DELETE FROM users`);
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
  await pool.query(`INSERT INTO settings (key, value) VALUES
      ('retirada_ativa','true'),('entrega_ativa','true'),('reserva_minutos','15'),('desconto_pix_percent','0'),
      ('retirada_prazo','"Pronto em até 30 minutos."')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await pool.query(`DELETE FROM delivery_zones`);
  await pool.query(`INSERT INTO delivery_zones (name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, sort_order)
    VALUES ('São Raimundo e entorno', ARRAY['São Raimundo'], 500, 30, 60, 1)`);
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
}

export async function makeUser(role: 'cliente' | 'administrador' | 'atendimento' | 'estoque' = 'cliente', name?: string): Promise<TestUser> {
  pwHash ??= await hashPassword(PASSWORD, 10);
  seq++;
  const n = name ?? `${role === 'cliente' ? 'Cliente' : role} Teste ${seq}`;
  const u = await q1<TestUser>(
    pool,
    `INSERT INTO users (role, name, email, phone, password_hash) VALUES ($1,$2,$3,'98999990000',$4) RETURNING id, name, email, phone, role`,
    [role, n, `u${seq}.${role}@teste.local`, pwHash],
  );
  return u!;
}

export const actorOf = (u: TestUser): Actor => ({ id: u.id, role: u.role, name: u.name });

let catId: number | null = null;
export async function makeSku(o: { name?: string; price?: number; stock?: number; min?: number; status?: string; sku?: string } = {}): Promise<{ skuId: string; productId: string; sku: string }> {
  seq++;
  if (catId === null || !(await q1(pool, 'SELECT 1 AS x FROM categories WHERE id = $1', [catId]))) {
    catId = (await q1<{ id: number }>(pool, `INSERT INTO categories (name, slug) VALUES ('Teste','teste-${Date.now()}') RETURNING id`))!.id;
  }
  const p = await q1<{ id: string }>(pool, `INSERT INTO products (category_id, name, status) VALUES ($1,$2,$3) RETURNING id`, [catId, o.name ?? `Produto ${seq}`, o.status ?? 'publicado']);
  const code = o.sku ?? `SKU-${seq}`;
  const s = await q1<{ id: string }>(
    pool,
    `INSERT INTO skus (product_id, sku, price_cents, cost_cents, min_stock, stock_physical) VALUES ($1,$2,$3,500,$4,$5) RETURNING id`,
    [p!.id, code, o.price ?? 1500, o.min ?? 0, o.stock ?? 10],
  );
  return { skuId: s!.id, productId: p!.id, sku: code };
}

export async function stockOf(skuId: string) {
  const r = await q1<{ physical: number; reserved: number; damaged: number }>(
    pool,
    `SELECT stock_physical AS physical, stock_reserved AS reserved, stock_damaged AS damaged FROM skus WHERE id = $1`,
    [skuId],
  );
  return { ...r!, available: r!.physical - r!.reserved - r!.damaged };
}

export const asCustomer = (u: TestUser) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });

export async function placeOrder(u: TestUser, items: { skuId: string; quantity: number }[], mode: 'retirada' | 'entrega' = 'retirada', extra: { addressId?: string; key?: string; paymentMethod?: 'pix' | 'local' } = {}) {
  seq++;
  return orders.createCheckout(asCustomer(u), {
    items,
    deliveryMode: mode,
    addressId: extra.addressId ?? null,
    paymentMethod: extra.paymentMethod ?? 'pix',
    idempotencyKey: extra.key ?? `teste-${seq}-${Math.random().toString(36).slice(2)}`,
  });
}

/** Cliente "paga no banco": o simulador marca a cobrança paga e entrega o webhook assinado ao app. */
export async function pay(orderId: string, settledAt?: Date) {
  return orders.simulatePixPayment(orderId, { settledAt });
}

export async function chargeOf(orderId: string) {
  return (await q1<{ id: string; providerChargeId: string; status: string }>(pool, `SELECT id, provider_charge_id, status FROM pix_charges WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]))!;
}

export const sim = () => getSimulatedProvider();

export async function count(table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  return (await q1<{ n: number }>(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))!.n;
}

export async function orderRow(orderId: string) {
  return (await q1<{ paymentStatus: string; fulfillmentStatus: string; reservationStatus: string; number: number; paidAt: Date | null; latePayment: boolean }>(
    pool,
    `SELECT payment_status, fulfillment_status, reservation_status, number, paid_at, late_payment FROM orders WHERE id = $1`,
    [orderId],
  ))!;
}
