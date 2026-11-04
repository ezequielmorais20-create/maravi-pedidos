/**
 * Dados FICTÍCIOS de demonstração. Nunca roda em produção.
 *   npm run db:seed              -> cria os dados (não faz nada se já existirem)
 *   SEED_RESET=1 npm run db:seed -> apaga os dados operacionais e recria
 * Preços de exemplo: rímel e esfoliante R$ 15, acessórios R$ 10, óculos R$ 20.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { closePool, pool, q1, tx } from './db';
import type { Actor } from './lib/audit';
import { hashPassword } from './lib/security';
import { runMigrations } from './migrate';
import { isPixSimulated } from './pix';
import * as auth from './services/auth';
import * as catalog from './services/catalog';
import * as orders from './services/orders';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

type IconName = 'rimel' | 'jar' | 'batom' | 'xuxinha' | 'oculos' | 'necessaire' | 'presilha' | 'tubo';

const ICONS: Record<IconName, (c: string) => string> = {
  rimel: (c) => `<rect x="-20" y="-70" width="40" height="120" rx="12" fill="${c}"/><rect x="-26" y="-104" width="52" height="38" rx="9" fill="${c}" opacity=".8"/><rect x="-4" y="50" width="8" height="46" rx="4" fill="${c}" opacity=".6"/>`,
  jar: (c) => `<rect x="-74" y="-20" width="148" height="92" rx="18" fill="${c}"/><rect x="-80" y="-56" width="160" height="38" rx="11" fill="${c}" opacity=".75"/>`,
  batom: (c) => `<rect x="-28" y="0" width="56" height="74" rx="8" fill="${c}"/><path d="M-22 0 L-22 -50 Q0 -90 22 -50 L22 0 Z" fill="${c}" opacity=".7"/>`,
  xuxinha: (c) => `<circle r="56" fill="none" stroke="${c}" stroke-width="30"/><circle r="56" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="6" stroke-dasharray="10 14"/>`,
  oculos: (c) => `<circle cx="-52" cy="0" r="42" fill="none" stroke="${c}" stroke-width="12"/><circle cx="52" cy="0" r="42" fill="none" stroke="${c}" stroke-width="12"/><path d="M-10 -6 Q0 -18 10 -6" fill="none" stroke="${c}" stroke-width="10"/><path d="M-94 -8 L-118 -22 M94 -8 L118 -22" stroke="${c}" stroke-width="10" stroke-linecap="round"/>`,
  necessaire: (c) => `<rect x="-86" y="-40" width="172" height="100" rx="22" fill="${c}"/><path d="M-86 -14 H86" stroke="#fff" stroke-opacity=".5" stroke-width="6" stroke-dasharray="8 8"/>`,
  presilha: (c) => `<path d="M-84 20 Q0 -80 84 20 L66 36 Q0 -34 -66 36 Z" fill="${c}"/><rect x="-70" y="26" width="140" height="18" rx="9" fill="${c}" opacity=".7"/>`,
  tubo: (c) => `<rect x="-24" y="-80" width="48" height="140" rx="14" fill="${c}"/><rect x="-16" y="60" width="32" height="26" rx="6" fill="${c}" opacity=".7"/>`,
};

function writePlaceholder(file: string, title: string, bg: string, icon: IconName): string {
  const dir = path.join(config.uploadDir, 'seed');
  mkdirSync(dir, { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="${esc(title)}">
<rect width="400" height="400" fill="${bg}"/>
<g transform="translate(200 170)">${ICONS[icon]('#E58BA4')}</g>
<text x="200" y="332" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="700" fill="#741039">${esc(title)}</text>
<text x="200" y="365" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" fill="#B35A76">Imagem ilustrativa de demonstração</text>
</svg>`;
  writeFileSync(path.join(dir, file), svg, 'utf8');
  return `/uploads/seed/${file}`;
}

interface Demo {
  name: string;
  desc: string;
  cat: string;
  icon: IconName;
  bg: string;
  status?: 'publicado' | 'rascunho';
  skus: { sku: string; variant?: string; price: number; cost: number; stock: number; min: number }[];
}

const DEMO: Demo[] = [
  { name: 'Rímel Volume Total', desc: 'Máscara de cílios preta, efeito volume, à prova d’água.', cat: 'Maquiagem', icon: 'rimel', bg: '#FCE8EF', skus: [{ sku: 'RIM-001', price: 1500, cost: 0, stock: 30, min: 5 }] },
  {
    name: 'Batom Matte',
    desc: 'Acabamento matte de longa duração.',
    cat: 'Maquiagem',
    icon: 'batom',
    bg: '#FCE8EF',
    skus: [
      { sku: 'BAT-ROS', variant: 'Rosa Chá', price: 1500, cost: 0, stock: 12, min: 4 },
      { sku: 'BAT-VIN', variant: 'Vinho', price: 1500, cost: 0, stock: 1, min: 4 },
      { sku: 'BAT-NUD', variant: 'Nude', price: 1500, cost: 0, stock: 0, min: 4 },
    ],
  },
  { name: 'Esfoliante Corporal de Açúcar', desc: 'Esfoliante suave com óleo de amêndoas.', cat: 'Cuidados pessoais', icon: 'jar', bg: '#F8D5E0', skus: [{ sku: 'ESF-COR', price: 1500, cost: 0, stock: 20, min: 4 }] },
  { name: 'Esfoliante Labial', desc: 'Remove as peles e deixa os lábios macios.', cat: 'Cuidados pessoais', icon: 'tubo', bg: '#F8D5E0', skus: [{ sku: 'ESF-LAB', price: 1500, cost: 0, stock: 15, min: 4 }] },
  {
    name: 'Xuxinha de Cetim',
    desc: 'Elástico de cabelo em cetim, não marca.',
    cat: 'Acessórios',
    icon: 'xuxinha',
    bg: '#FFF0F5',
    skus: [
      { sku: 'XUX-ROS', variant: 'Rosa', price: 1000, cost: 0, stock: 40, min: 8 },
      { sku: 'XUX-PRE', variant: 'Preto', price: 1000, cost: 0, stock: 35, min: 8 },
    ],
  },
  { name: 'Presilha Garra', desc: 'Presilha garra média, várias cores.', cat: 'Acessórios', icon: 'presilha', bg: '#FFF0F5', skus: [{ sku: 'PRE-GAR', price: 1000, cost: 0, stock: 25, min: 5 }] },
  { name: 'Necessaire Rosa', desc: 'Necessaire com zíper, ideal para maquiagem.', cat: 'Acessórios', icon: 'necessaire', bg: '#FFF0F5', skus: [{ sku: 'NEC-ROS', price: 1000, cost: 0, stock: 0, min: 3 }] },
  {
    name: 'Óculos de Sol Gatinho',
    desc: 'Armação gatinho com proteção UV.',
    cat: 'Óculos',
    icon: 'oculos',
    bg: '#F3C9D8',
    skus: [
      { sku: 'OCU-GAT-PRE', variant: 'Preto', price: 2000, cost: 0, stock: 14, min: 3 },
      { sku: 'OCU-GAT-TAR', variant: 'Tartaruga', price: 2000, cost: 0, stock: 9, min: 3 },
    ],
  },
  { name: 'Óculos Redondo Vintage', desc: 'Armação redonda leve, lentes UV400.', cat: 'Óculos', icon: 'oculos', bg: '#F3C9D8', skus: [{ sku: 'OCU-RED', price: 2000, cost: 0, stock: 10, min: 3 }] },
  { name: 'Hidratante Labial (em breve)', desc: 'Rascunho: ainda não publicado.', cat: 'Cuidados pessoais', icon: 'tubo', bg: '#F8D5E0', status: 'rascunho', skus: [{ sku: 'HID-LAB', price: 1200, cost: 0, stock: 0, min: 3 }] },
];

async function reset(): Promise<void> {
  // Preserva settings, delivery_zones e schema_migrations (configuração da loja).
  await pool.query(`TRUNCATE order_exceptions, stock_movements, cash_entries, refunds, payments, provider_events, pix_charges, order_events, order_items, orders,
    sku_price_history, skus, product_images, products, categories, addresses, password_resets, sessions, outbox_emails, audit_log, pix_simulator_charges RESTART IDENTITY`);
  await pool.query(`UPDATE settings SET updated_by = NULL`);
  await pool.query(`DELETE FROM users`);
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
}

async function main(): Promise<void> {
  if (config.isProd) throw new Error('O seed de demonstração é bloqueado em produção.');
  if (config.seedPassword.length < 12) throw new Error('Defina SEED_PASSWORD com pelo menos 12 caracteres em seu ambiente local antes do seed.');
  await runMigrations();
  if (process.env.SEED_RESET === '1') await reset();

  const existing = await q1(pool, `SELECT 1 AS x FROM users WHERE email = 'admin@maravi.demo'`);
  if (existing) {
    console.log('Dados de demonstração já existem. Use SEED_RESET=1 para recriar.');
    return;
  }

  const pw = await hashPassword(config.seedPassword, config.scryptCost);
  const users: Record<string, { id: string }> = {};
  for (const [key, role, name, email] of [
    ['admin', 'administrador', 'Administradora MARAVI', 'admin@maravi.demo'],
    ['atend', 'atendimento', 'Atendimento MARAVI', 'atendimento@maravi.demo'],
    ['estoque', 'estoque', 'Estoque MARAVI', 'estoque@maravi.demo'],
    ['c1', 'cliente', 'Maria Clara Souza', 'cliente@maravi.demo'],
    ['c2', 'cliente', 'Joana Pereira Lima', 'cliente2@maravi.demo'],
  ] as const) {
    users[key] = (await q1<{ id: string }>(pool, `INSERT INTO users (role, name, email, phone, password_hash) VALUES ($1,$2,$3,'98999990000',$4) RETURNING id`, [role, name, email, pw]))!;
  }
  const adminActor: Actor = { id: users.admin.id, role: 'administrador', name: 'Administradora MARAVI' };

  const cats = new Map<string, number>();
  for (const name of ['Maquiagem', 'Cuidados pessoais', 'Acessórios', 'Óculos']) {
    cats.set(name, (await tx((c) => catalog.createCategory(c, adminActor, name))).id);
  }

  for (const d of DEMO) {
    const slug = d.skus[0].sku.toLowerCase();
    const img = writePlaceholder(`${slug}.svg`, d.name, d.bg, d.icon);
    await tx((c) =>
      catalog.createProduct(c, adminActor, {
        name: d.name,
        description: d.desc,
        categoryId: cats.get(d.cat)!,
        status: d.status ?? 'publicado',
        images: [img],
        skus: d.skus.map((s) => ({ sku: s.sku, variantName: s.variant ?? 'Único', priceCents: s.price, costCents: s.cost, minStock: s.min, active: true, initialStock: s.stock })),
      }),
    );
  }

  await auth.saveAddress(users.c1.id, null, { label: 'Casa', recipient: 'Maria Clara Souza', phone: '98999990000', cep: '65000000', street: 'Rua das Flores', number: '120', neighborhood: 'Centro', isDefault: true });
  const addr2 = (await auth.saveAddress(users.c2.id, null, { label: 'Casa', recipient: 'Joana Pereira Lima', phone: '98988880000', cep: '65000000', street: 'Av. do São Raimundo', number: '45', neighborhood: 'São Raimundo', isDefault: true })) as { id: string };

  if (isPixSimulated()) {
    const skuId = async (sku: string) => (await q1<{ id: string }>(pool, `SELECT id FROM skus WHERE sku = $1`, [sku]))!.id;
    const cust = (k: 'c1' | 'c2', name: string, email: string) => ({ id: users[k].id, name, email, phone: '98999990000' });
    const now = Date.now();
    // Pedido A: criado primeiro, mas o Pix liquidou DEPOIS.
    const a = await orders.createCheckout(cust('c1', 'Maria Clara Souza', 'cliente@maravi.demo'), {
      items: [{ skuId: await skuId('RIM-001'), quantity: 1 }, { skuId: await skuId('ESF-COR'), quantity: 1 }],
      deliveryMode: 'retirada',
      idempotencyKey: 'seed-pedido-a',
    });
    // Pedido B: criado depois, mas o Pix liquidou ANTES => aparece primeiro na fila.
    const b = await orders.createCheckout(cust('c2', 'Joana Pereira Lima', 'cliente2@maravi.demo'), {
      items: [{ skuId: await skuId('OCU-GAT-PRE'), quantity: 1 }, { skuId: await skuId('XUX-ROS'), quantity: 2 }],
      deliveryMode: 'entrega',
      addressId: addr2.id,
      idempotencyKey: 'seed-pedido-b',
    });
    // Pedido C: aguardando Pix.
    await orders.createCheckout(cust('c1', 'Maria Clara Souza', 'cliente@maravi.demo'), {
      items: [{ skuId: await skuId('BAT-ROS'), quantity: 1 }],
      deliveryMode: 'retirada',
      idempotencyKey: 'seed-pedido-c',
    });
    await orders.simulatePixPayment(a.id as string, { settledAt: new Date(now - 5 * 60_000) });
    await orders.simulatePixPayment(b.id as string, { settledAt: new Date(now - 12 * 60_000) });
  } else {
    console.log('PIX_MODE não é "simulado": pedidos de demonstração não foram criados.');
  }

  console.log('\nDados de demonstração criados. Logins: a senha é a definida localmente em SEED_PASSWORD e não é exibida.');
  console.log('  Administradora : admin@maravi.demo');
  console.log('  Atendimento    : atendimento@maravi.demo');
  console.log('  Estoque        : estoque@maravi.demo');
  console.log('  Cliente 1      : cliente@maravi.demo');
  console.log('  Cliente 2      : cliente2@maravi.demo\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
