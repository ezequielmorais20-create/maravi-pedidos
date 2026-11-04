import { useSearchParams } from 'react-router-dom';
import ProductCard from '../../components/ProductCard';
import { Alert, Empty, Loading } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { useAsync } from '../../lib/hooks';

export default function Catalogo() {
  const [sp, setSp] = useSearchParams();
  const f = { q: sp.get('q') ?? '', category: sp.get('category') ?? '', inStock: sp.get('inStock') ?? '', sort: sp.get('sort') ?? 'novos', minPrice: sp.get('minPrice') ?? '', maxPrice: sp.get('maxPrice') ?? '', page: sp.get('page') ?? '1' };
  const cats = useAsync(() => get('/api/catalog/categories'));
  const r = useAsync(
    () => get('/api/catalog/products' + qs({ ...f, minPrice: f.minPrice ? Math.round(Number(f.minPrice) * 100) : undefined, maxPrice: f.maxPrice ? Math.round(Number(f.maxPrice) * 100) : undefined })),
    [sp.toString()],
  );
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n, { replace: true });
  };
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / r.data.pageSize)) : 1;
  return (
    <>
      <h1>Catálogo</h1>
      <div className="card">
        <label htmlFor="busca">Buscar</label>
        <input id="busca" type="search" placeholder="Ex.: rímel, óculos, esfoliante" defaultValue={f.q} onKeyDown={(e) => { if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value.trim()); }} onBlur={(e) => set('q', e.target.value.trim())} />
        <div className="row">
          <div style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="cat">Categoria</label>
            <select id="cat" value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Todas</option>
              {cats.data?.items.map((c: any) => <option key={c.id} value={c.slug}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="ord">Ordenar</label>
            <select id="ord" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="novos">Novidades</option><option value="menor_preco">Menor preço</option><option value="maior_preco">Maior preço</option><option value="nome">Nome (A–Z)</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 100 }}><label htmlFor="pmin">Preço mín. (R$)</label><input id="pmin" inputMode="decimal" defaultValue={f.minPrice} onBlur={(e) => set('minPrice', e.target.value)} /></div>
          <div style={{ flex: 1, minWidth: 100 }}><label htmlFor="pmax">Preço máx. (R$)</label><input id="pmax" inputMode="decimal" defaultValue={f.maxPrice} onBlur={(e) => set('maxPrice', e.target.value)} /></div>
        </div>
        <label><input type="checkbox" checked={f.inStock === 'true'} onChange={(e) => set('inStock', e.target.checked ? 'true' : '')} /> Só o que tem em estoque</label>
      </div>
      {r.error && <Alert>{r.error}</Alert>}
      {r.loading ? <Loading /> : r.data && r.data.items.length === 0 ? <Empty>Nenhum produto encontrado com esses filtros.</Empty> : (
        <div className="grid">{r.data?.items.map((p: any) => <ProductCard key={p.id} p={p} />)}</div>
      )}
      {pages > 1 && (
        <div className="row mt" style={{ justifyContent: 'center' }}>
          <button className="btn sec sm" disabled={Number(f.page) <= 1} onClick={() => set('page', String(Number(f.page) - 1))}>Anterior</button>
          <span className="muted">Página {f.page} de {pages}</span>
          <button className="btn sec sm" disabled={Number(f.page) >= pages} onClick={() => set('page', String(Number(f.page) + 1))}>Próxima</button>
        </div>
      )}
    </>
  );
}
