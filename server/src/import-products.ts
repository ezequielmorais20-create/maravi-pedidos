/**
 * Importa o cadastro de produtos da MARAVI (server/data/produtos-maravi.json, gerado da planilha de precificação).
 * Seguro para repetir: SKU que já existe é ignorado (nada é sobrescrito). Estoque inicial vem do JSON (400 un. por produto).
 * até a equipe lançar a entrada em Painel → Estoque.
 * Uso: npm run import-products -w server
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closePool, q1, tx } from './db';
import { SYSTEM_ACTOR } from './lib/audit';
import { createProduct } from './services/catalog';

interface Item { sku: string; nome: string; categoria: string; custoCents: number; precoCents: number; estoque: number }

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main(): Promise<void> {
  const items: Item[] = JSON.parse(readFileSync(path.resolve(__dirname, '../data/produtos-maravi.json'), 'utf8'));
  let criados = 0;
  let ignorados = 0;
  for (const it of items) {
    await tx(async (c) => {
      if (await q1(c, `SELECT 1 AS x FROM skus WHERE sku = $1`, [it.sku])) { ignorados++; return; }
      const cat = await q1<{ id: number }>(
        c,
        `INSERT INTO categories (name, slug) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [it.categoria, slug(it.categoria)],
      );
      await createProduct(c, SYSTEM_ACTOR, {
        name: it.nome,
        description: '',
        categoryId: cat!.id,
        status: 'publicado',
        images: [],
        skus: [{ sku: it.sku, variantName: 'Único', priceCents: it.precoCents, costCents: it.custoCents, minStock: 0, active: true, initialStock: it.estoque }],
      });
      criados++;
    });
  }
  console.log(`Produtos criados: ${criados} · já existentes (ignorados): ${ignorados}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => closePool());
