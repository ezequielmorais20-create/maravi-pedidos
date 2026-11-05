import { useState } from 'react';
import { Alert, Loading } from '../../components/ui';
import { api, get, post, put, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, centsToReais, reaisToCents } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';

const blank = { id: null as string | null, name: '', description: '', categoryId: 0, status: 'rascunho', images: [] as string[], skus: [{ sku: '', variantName: 'Único', price: '', cost: '', minStock: '0', initialStock: '0', active: true, id: undefined as string | undefined }] };

export default function Produtos() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useAsync(() => get(`/api/staff/products${qs({ q, status })}`), [q, status]);
  const cats = useAsync(() => get('/api/staff/categories'));
  const [edit, setEdit] = useState<typeof blank | null>(null);
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const canEdit = can('products.edit');
  async function open(id: string) {
    const p = await get(`/api/staff/products/${id}`);
    setEdit({ id: p.id, name: p.name, description: p.description ?? '', categoryId: p.categoryId, status: p.status, images: (p.images ?? []).map((i: any) => i.url),
      skus: p.skus.map((s: any) => ({ id: s.id, sku: s.sku, variantName: s.variantName, price: centsToReais(s.priceCents), cost: s.costCents != null ? centsToReais(s.costCents) : '', minStock: String(s.minStock), initialStock: '0', active: s.active })) });
  }
  return (
    <>
      <div className="row sb"><h1>Produtos</h1>{canEdit && <button className="btn" onClick={() => setEdit({ ...blank, categoryId: cats.data?.items[0]?.id ?? 0 })}>Novo produto</button>}</div>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="card product-filters">
        <div className="product-filter-field"><label htmlFor="pq">Buscar</label><input id="pq" onBlur={(e) => setQ(e.target.value.trim())} /></div>
        <div className="product-filter-field"><label htmlFor="ps">Situação</label><select id="ps" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option><option value="publicado">Publicado</option><option value="rascunho">Rascunho</option><option value="arquivado">Arquivado</option></select></div>
      </div>
      {list.loading ? <Loading /> : (
        <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label="Produtos cadastrados; deslize horizontalmente para consultar todas as colunas"><table className="panel-table-products">
          <thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th className="n">Disponível</th><th>Situação</th><th /></tr></thead>
          <tbody>{list.data?.items.map((p: any) => <tr key={p.id}><td>{p.name}</td><td>{p.category}</td><td>{p.minPriceCents != null ? brl(p.minPriceCents) : '—'}</td><td className="n">{p.availableTotal ?? '—'}</td><td><span className={`tag ${p.status === 'publicado' ? 'ok' : ''}`}>{p.status}</span></td><td>{canEdit && <button className="btn sm sec" onClick={() => void open(p.id)}>Editar</button>}</td></tr>)}</tbody>
        </table></div>
      )}
      {edit && <ProductForm init={edit} cats={cats.data?.items ?? []} showCost={can('products.cost')} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); setMsg({ k: 'ok', t: 'Produto salvo.' }); void list.reload(true); }} />}
    </>
  );
}

function ProductForm({ init, cats, showCost, onSaved, onCancel }: { init: typeof blank; cats: any[]; showCost: boolean; onSaved: () => void; onCancel: () => void }) {
  const [p, setP] = useState(init);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setSku = (i: number, k: string, v: any) => setP({ ...p, skus: p.skus.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  async function upload(f: File) {
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api<{ url: string }>('POST', '/api/staff/uploads', fd); setP((cur) => ({ ...cur, images: [...cur.images, r.url] })); } catch (e) { setErr(errMsg(e)); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body = {
        name: p.name, description: p.description, categoryId: Number(p.categoryId), status: p.status, images: p.images,
        skus: p.skus.map((s) => ({ ...(s.id ? { id: s.id } : {}), sku: s.sku, variantName: s.variantName || 'Único', priceCents: reaisToCents(s.price), ...(showCost && s.cost !== '' ? { costCents: reaisToCents(s.cost) } : {}), minStock: Number(s.minStock) || 0, active: s.active, ...(!s.id && Number(s.initialStock) > 0 ? { initialStock: Number(s.initialStock) } : {}) })),
      };
      if (p.id) await put(`/api/staff/products/${p.id}`, body); else await post('/api/staff/products', body);
      onSaved();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <form className="card mt product-form" onSubmit={submit}>
      <h2>{p.id ? 'Editar produto' : 'Novo produto'}</h2>
      {err && <Alert>{err}</Alert>}
      <label htmlFor="fn">Nome</label><input id="fn" required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
      <label htmlFor="fd">Descrição</label><textarea id="fd" rows={3} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
      <div className="row product-meta-fields">
        <div style={{ flex: 1 }}><label htmlFor="fc">Categoria</label><select id="fc" value={p.categoryId} onChange={(e) => setP({ ...p, categoryId: Number(e.target.value) })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div style={{ flex: 1 }}><label htmlFor="fs">Situação</label><select id="fs" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value })}><option value="rascunho">Rascunho</option><option value="publicado">Publicado</option><option value="arquivado">Arquivado</option></select></div>
      </div>
      <label htmlFor="fi">Fotos (PNG, JPG ou WEBP até 4 MB)</label>
      <input id="fi" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ''; }} />
      <div className="row mt product-images">{p.images.map((u, i) => <span key={u} className="product-image-item"><img src={u} alt={`Foto ${i + 1}`} width={64} height={64} style={{ borderRadius: 8, objectFit: 'cover' }} /><button type="button" className="btn sm sec product-image-remove" aria-label={`Remover foto ${i + 1}`} onClick={() => setP({ ...p, images: p.images.filter((x) => x !== u) })}>×</button></span>)}</div>
      <h3>Variações (SKU)</h3>
      {p.skus.map((s, i) => (
        <div key={i} className="card product-sku-card" style={{ background: 'var(--rosa-claro)' }}>
          <div className="row product-sku-fields">
            <div className="product-sku-field"><label htmlFor={`sku-${i}`}>SKU</label><input id={`sku-${i}`} required value={s.sku} onChange={(e) => setSku(i, 'sku', e.target.value)} /></div>
            <div className="product-sku-field"><label htmlFor={`variant-${i}`}>Variação</label><input id={`variant-${i}`} value={s.variantName} onChange={(e) => setSku(i, 'variantName', e.target.value)} /></div>
            <div className="product-sku-field"><label htmlFor={`price-${i}`}>Preço (R$)</label><input id={`price-${i}`} required inputMode="decimal" value={s.price} onChange={(e) => setSku(i, 'price', e.target.value)} /></div>
            {showCost && <div className="product-sku-field"><label htmlFor={`cost-${i}`}>Custo (R$)</label><input id={`cost-${i}`} inputMode="decimal" value={s.cost} onChange={(e) => setSku(i, 'cost', e.target.value)} /></div>}
            <div className="product-sku-field"><label htmlFor={`min-stock-${i}`}>Estoque mínimo</label><input id={`min-stock-${i}`} type="number" min={0} value={s.minStock} onChange={(e) => setSku(i, 'minStock', e.target.value)} /></div>
            {!s.id && <div className="product-sku-field"><label htmlFor={`initial-stock-${i}`}>Estoque inicial</label><input id={`initial-stock-${i}`} type="number" min={0} value={s.initialStock} onChange={(e) => setSku(i, 'initialStock', e.target.value)} /></div>}
          </div>
          <label className="product-active"><input type="checkbox" checked={s.active} onChange={(e) => setSku(i, 'active', e.target.checked)} /> Ativa</label>
          {!s.id && p.skus.length > 1 && <button type="button" className="btn sm sec" onClick={() => setP({ ...p, skus: p.skus.filter((_, j) => j !== i) })}>Remover variação</button>}
        </div>
      ))}
      <button type="button" className="btn sec sm" onClick={() => setP({ ...p, skus: [...p.skus, { ...blank.skus[0]!, sku: '' }] })}>+ Variação</button>
      <p className="muted">O preço muda só para pedidos futuros; pedidos já feitos mantêm o preço da compra. Estoque depois de criado só muda em Estoque (com motivo).</p>
      <div className="row mt product-form-actions"><button className="btn" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button><button type="button" className="btn sec" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}
