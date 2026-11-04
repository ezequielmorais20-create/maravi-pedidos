import type { PoolClient } from 'pg';
import { q, q1, type Db } from '../db';
import { audit, type Actor } from '../lib/audit';
import { conflict, forbidden, notFound, pgCode, pgConstraint } from '../lib/errors';
import { escapeLike } from '../lib/text';
import * as stock from './stock';

// ---------------------------------------------------------------------------
// Vitrine (público)
// ---------------------------------------------------------------------------
const PUBLIC_SKUS = `
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'sku', s.sku, 'variantName', s.variant_name, 'priceCents', s.price_cents,
      'available', GREATEST(0, s.stock_physical - s.stock_reserved - s.stock_damaged),
      'imageUrl', s.image_url) ORDER BY s.price_cents, s.variant_name)
    FROM skus s WHERE s.product_id = p.id AND s.active), '[]'::jsonb)`;
const PUBLIC_IMAGES = `COALESCE((SELECT jsonb_agg(i.url ORDER BY i.sort_order, i.id) FROM product_images i WHERE i.product_id = p.id), '[]'::jsonb)`;

export async function listCategories(db: Db) {
  return q(db, `SELECT id, name, slug FROM categories WHERE active ORDER BY sort_order, name`);
}

export interface CatalogFilter {
  q?: string;
  category?: string; // slug
  inStock?: boolean;
  minPriceCents?: number;
  maxPriceCents?: number;
  sort?: 'novos' | 'menor_preco' | 'maior_preco' | 'nome';
  page?: number;
  pageSize?: number;
}

export async function listPublicProducts(db: Db, f: CatalogFilter) {
  const params: unknown[] = [];
  const where = [`p.status = 'publicado'`, `c.active`, `EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.active)`];
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    where.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (f.category) {
    params.push(f.category);
    where.push(`c.slug = $${params.length}`);
  }
  if (f.inStock) where.push(`EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.active AND s.stock_physical - s.stock_reserved - s.stock_damaged > 0)`);
  if (f.minPriceCents !== undefined) {
    params.push(f.minPriceCents);
    where.push(`EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.active AND s.price_cents >= $${params.length})`);
  }
  if (f.maxPriceCents !== undefined) {
    params.push(f.maxPriceCents);
    where.push(`EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.active AND s.price_cents <= $${params.length})`);
  }
  const minPrice = `(SELECT MIN(s.price_cents) FROM skus s WHERE s.product_id = p.id AND s.active)`;
  const order =
    f.sort === 'menor_preco' ? `${minPrice} ASC, p.name`
    : f.sort === 'maior_preco' ? `${minPrice} DESC, p.name`
    : f.sort === 'nome' ? `p.name`
    : `p.created_at DESC, p.name`;
  const pageSize = Math.min(Math.max(f.pageSize ?? 24, 1), 60);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const whereSql = where.join(' AND ');
  const total = await q1<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM products p JOIN categories c ON c.id = p.category_id WHERE ${whereSql}`, params);
  const items = await q(
    db,
    `SELECT p.id, p.name, p.description, c.name AS category, c.slug AS category_slug,
            ${PUBLIC_SKUS} AS skus, ${PUBLIC_IMAGES} AS images, ${minPrice} AS min_price_cents
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE ${whereSql} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  return { items, total: total?.n ?? 0, page: Math.max(f.page ?? 1, 1), pageSize };
}

export async function getPublicProduct(db: Db, id: string) {
  const p = await q1(
    db,
    `SELECT p.id, p.name, p.description, c.name AS category, c.slug AS category_slug,
            ${PUBLIC_SKUS} AS skus, ${PUBLIC_IMAGES} AS images
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1 AND p.status = 'publicado' AND c.active`,
    [id],
  );
  if (!p) throw notFound('Produto não encontrado.');
  return p;
}

// ---------------------------------------------------------------------------
// Gestão (equipe)
// ---------------------------------------------------------------------------
export async function listProductsStaff(db: Db, f: { q?: string; status?: string; categoryId?: number }, showCost: boolean) {
  const params: unknown[] = [];
  const where: string[] = ['TRUE'];
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    where.push(`(p.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.sku ILIKE $${params.length}))`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`p.status = $${params.length}`);
  }
  if (f.categoryId) {
    params.push(f.categoryId);
    where.push(`p.category_id = $${params.length}`);
  }
  return q(
    db,
    `SELECT p.id, p.name, p.status, c.name AS category, p.category_id, p.updated_at,
            (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order, id LIMIT 1) AS image,
            (SELECT COUNT(*)::int FROM skus s WHERE s.product_id = p.id) AS sku_count,
            (SELECT MIN(price_cents) FROM skus s WHERE s.product_id = p.id AND s.active) AS min_price_cents,
            (SELECT MAX(price_cents) FROM skus s WHERE s.product_id = p.id AND s.active) AS max_price_cents,
            (SELECT COALESCE(SUM(GREATEST(0, s.stock_physical - s.stock_reserved - s.stock_damaged)),0)::int FROM skus s WHERE s.product_id = p.id) AS available_total,
            ${showCost ? `(SELECT MIN(cost_cents) FROM skus s WHERE s.product_id = p.id) AS min_cost_cents,` : ''}
            EXISTS (SELECT 1 FROM skus s JOIN order_items oi ON oi.sku_id = s.id WHERE s.product_id = p.id) AS has_sales
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`,
    params,
  );
}

export async function getProductStaff(db: Db, id: string, o: { showCost: boolean; showPriceHistory: boolean }) {
  const p = await q1(db, `SELECT p.id, p.name, p.description, p.status, p.category_id, p.created_at, p.updated_at FROM products p WHERE p.id = $1`, [id]);
  if (!p) throw notFound('Produto não encontrado.');
  const images = await q(db, `SELECT id, url, alt, sort_order FROM product_images WHERE product_id = $1 ORDER BY sort_order, id`, [id]);
  const skus = await q(
    db,
    `SELECT s.id, s.sku, s.variant_name, s.price_cents, ${o.showCost ? 's.cost_cents,' : ''} s.min_stock, s.active, s.image_url,
            s.stock_physical AS physical, s.stock_reserved AS reserved, s.stock_damaged AS damaged,
            (s.stock_physical - s.stock_reserved - s.stock_damaged) AS available,
            EXISTS (SELECT 1 FROM order_items oi WHERE oi.sku_id = s.id) AS has_sales
       FROM skus s WHERE s.product_id = $1 ORDER BY s.variant_name`,
    [id],
  );
  let history: unknown[] = [];
  if (o.showPriceHistory) {
    history = await q(
      db,
      `SELECT h.id, h.sku_id, s.sku, h.price_cents, ${o.showCost ? 'h.cost_cents,' : ''} h.changed_at, u.name AS changed_by_name
         FROM sku_price_history h JOIN skus s ON s.id = h.sku_id LEFT JOIN users u ON u.id = h.changed_by
        WHERE s.product_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    );
  }
  return { ...p, images, skus, priceHistory: history };
}

export interface SkuInput {
  id?: string;
  sku: string;
  variantName: string;
  priceCents: number;
  costCents?: number;
  minStock: number;
  active: boolean;
  imageUrl?: string | null;
  initialStock?: number;
}
export interface ProductInput {
  name: string;
  description: string;
  categoryId: number;
  status: 'rascunho' | 'publicado' | 'arquivado';
  images: string[];
  skus: SkuInput[];
}
export interface EditCaps {
  price: boolean;
  cost: boolean;
}

function mapUnique(e: unknown): never {
  if (pgCode(e) === '23505' && pgConstraint(e)?.startsWith('skus_sku')) throw conflict('Já existe outro SKU com este código.', 'sku_duplicado');
  if (pgCode(e) === '23503') throw conflict('Categoria inválida.', 'categoria_invalida');
  throw e;
}

async function replaceImages(c: PoolClient, productId: string, urls: string[]): Promise<void> {
  await c.query(`DELETE FROM product_images WHERE product_id = $1`, [productId]);
  for (const [i, url] of urls.entries()) {
    await c.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES ($1,$2,$3)`, [productId, url, i]);
  }
}

export async function createProduct(c: PoolClient, actor: Actor, input: ProductInput): Promise<{ id: string }> {
  try {
    const p = await q1<{ id: string }>(
      c,
      `INSERT INTO products (category_id, name, description, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.categoryId, input.name, input.description, input.status],
    );
    const id = p!.id;
    await replaceImages(c, id, input.images);
    for (const s of input.skus) {
      const row = await q1<{ id: string }>(
        c,
        `INSERT INTO skus (product_id, sku, variant_name, price_cents, cost_cents, min_stock, active, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [id, s.sku.trim(), s.variantName, s.priceCents, s.costCents ?? 0, s.minStock, s.active, s.imageUrl ?? null],
      );
      await c.query(`INSERT INTO sku_price_history (sku_id, price_cents, cost_cents, changed_by) VALUES ($1,$2,$3,$4)`, [row!.id, s.priceCents, s.costCents ?? 0, actor.id]);
      if (s.initialStock && s.initialStock > 0) {
        await stock.entry(c, actor, { skuId: row!.id, quantity: s.initialStock, reason: 'Estoque inicial no cadastro' });
      }
    }
    await audit(c, actor, 'produto.criar', 'product', id, { name: input.name, skus: input.skus.map((s) => s.sku) });
    return { id };
  } catch (e) {
    return mapUnique(e);
  }
}

export async function updateProduct(c: PoolClient, actor: Actor, id: string, input: ProductInput, caps: EditCaps): Promise<void> {
  const cur = await q1(c, `SELECT id, name, status, category_id FROM products WHERE id = $1 FOR UPDATE`, [id]);
  if (!cur) throw notFound('Produto não encontrado.');
  try {
    await c.query(`UPDATE products SET name=$2, description=$3, category_id=$4, status=$5, updated_at=now() WHERE id=$1`, [id, input.name, input.description, input.categoryId, input.status]);
    await replaceImages(c, id, input.images);
    for (const s of input.skus) {
      if (s.id) {
        const old = await q1<{ priceCents: number; costCents: number; productId: string }>(c, `SELECT price_cents, cost_cents, product_id FROM skus WHERE id = $1 FOR UPDATE`, [s.id]);
        if (!old || old.productId !== id) throw notFound('SKU não pertence a este produto.');
        const newCost = s.costCents ?? old.costCents;
        if (s.priceCents !== old.priceCents && !caps.price) throw forbidden('Você não pode alterar preços.');
        if (newCost !== old.costCents && !caps.cost) throw forbidden('Você não pode alterar custos.');
        await c.query(
          `UPDATE skus SET sku=$2, variant_name=$3, price_cents=$4, cost_cents=$5, min_stock=$6, active=$7, image_url=$8, updated_at=now() WHERE id=$1`,
          [s.id, s.sku.trim(), s.variantName, s.priceCents, newCost, s.minStock, s.active, s.imageUrl ?? null],
        );
        if (s.priceCents !== old.priceCents || newCost !== old.costCents) {
          await c.query(`INSERT INTO sku_price_history (sku_id, price_cents, cost_cents, changed_by) VALUES ($1,$2,$3,$4)`, [s.id, s.priceCents, newCost, actor.id]);
          await audit(c, actor, 'produto.preco_alterado', 'sku', s.id, { priceFrom: old.priceCents, priceTo: s.priceCents, costFrom: caps.cost ? old.costCents : undefined, costTo: caps.cost ? newCost : undefined });
        }
      } else {
        if (!caps.price) throw forbidden('Você não pode cadastrar preços.');
        const row = await q1<{ id: string }>(
          c,
          `INSERT INTO skus (product_id, sku, variant_name, price_cents, cost_cents, min_stock, active, image_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id, s.sku.trim(), s.variantName, s.priceCents, caps.cost ? (s.costCents ?? 0) : 0, s.minStock, s.active, s.imageUrl ?? null],
        );
        await c.query(`INSERT INTO sku_price_history (sku_id, price_cents, cost_cents, changed_by) VALUES ($1,$2,$3,$4)`, [row!.id, s.priceCents, caps.cost ? (s.costCents ?? 0) : 0, actor.id]);
        if (s.initialStock && s.initialStock > 0) await stock.entry(c, actor, { skuId: row!.id, quantity: s.initialStock, reason: 'Estoque inicial no cadastro' });
      }
    }
    await audit(c, actor, 'produto.atualizar', 'product', id, { name: input.name, status: input.status });
  } catch (e) {
    mapUnique(e);
  }
}

export async function setProductStatus(c: PoolClient, actor: Actor, id: string, status: 'rascunho' | 'publicado' | 'arquivado'): Promise<void> {
  const r = await c.query(`UPDATE products SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
  if (r.rowCount === 0) throw notFound('Produto não encontrado.');
  await audit(c, actor, `produto.${status}`, 'product', id, {});
}

/** Só exclui produto sem nenhum histórico; com vendas/movimentos o caminho é arquivar. */
export async function deleteProduct(c: PoolClient, actor: Actor, id: string): Promise<void> {
  const hist = await q1<{ n: number }>(
    c,
    `SELECT (SELECT COUNT(*) FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE s.product_id = $1)
          + (SELECT COUNT(*) FROM stock_movements m JOIN skus s ON s.id = m.sku_id WHERE s.product_id = $1) AS n`,
    [id],
  );
  if ((hist?.n ?? 0) > 0) throw conflict('Este produto tem histórico de vendas ou estoque. Arquive-o em vez de excluir.', 'produto_com_historico');
  const r = await c.query(`DELETE FROM products WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw notFound('Produto não encontrado.');
  await audit(c, actor, 'produto.excluir', 'product', id, {});
}

export async function createCategory(c: PoolClient, actor: Actor, name: string): Promise<{ id: number }> {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  try {
    const row = await q1<{ id: number }>(c, `INSERT INTO categories (name, slug, sort_order) VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories)) RETURNING id`, [name, slug || 'categoria']);
    await audit(c, actor, 'categoria.criar', 'category', row!.id, { name });
    return row!;
  } catch (e) {
    if (pgCode(e) === '23505') throw conflict('Já existe uma categoria com este nome.', 'categoria_duplicada');
    throw e;
  }
}
