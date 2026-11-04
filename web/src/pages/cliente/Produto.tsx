import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Img, Loading } from '../../components/ui';
import { get } from '../../lib/api';
import { useCart } from '../../lib/cart';
import { brl } from '../../lib/format';
import { useAsync } from '../../lib/hooks';

export default function Produto() {
  const { id } = useParams();
  const { add } = useCart();
  const { data: p, loading, error } = useAsync(() => get(`/api/catalog/products/${id}`), [id]);
  const [sel, setSel] = useState<string | null>(null);
  const [img, setImg] = useState(0);
  const [done, setDone] = useState(false);
  if (loading) return <Loading />;
  if (error || !p) return <Alert>{error ?? 'Produto não encontrado.'}</Alert>;
  const skus: any[] = p.skus;
  const cur = skus.find((s) => s.id === sel) ?? skus.find((s) => s.available > 0) ?? skus[0];
  const photos: string[] = p.images?.length ? p.images : cur?.imageUrl ? [cur.imageUrl] : [];
  const hasPhoto = Boolean(photos[img] ?? cur?.imageUrl);
  return (
    <>
      <p><Link to="/catalogo">← Catálogo</Link></p>
      <div className="card">
        <div className="product-detail-media" style={{ maxWidth: 420, margin: '0 auto' }}><Img src={photos[img] ?? cur?.imageUrl} alt={hasPhoto ? `Foto ilustrativa de ${p.name}` : p.name} /></div>
        {hasPhoto && <p className="photo-disclaimer">Foto ilustrativa; cor e embalagem podem variar do produto disponível.</p>}
        {photos.length > 1 && <div className="row mt" style={{ justifyContent: 'center' }}>{photos.map((u, i) => <button key={u} className="btn sec sm" onClick={() => setImg(i)} aria-label={`Foto ${i + 1}`}>{i + 1}</button>)}</div>}
        <h1 className="mt">{p.name}</h1>
        <p className="muted">{p.category}</p>
        {p.description && <p>{p.description}</p>}
        {skus.length > 1 && (
          <>
            <label htmlFor="var">Variação</label>
            <select id="var" value={cur?.id} onChange={(e) => { setSel(e.target.value); setDone(false); }}>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.variantName} — {brl(s.priceCents)}{s.available === 0 ? ' (indisponível)' : ''}</option>)}
            </select>
          </>
        )}
        <p className="price" style={{ fontSize: '1.4rem' }}>{brl(cur?.priceCents)}</p>
        {cur?.available > 0 ? <p className="muted">{cur.available <= 5 ? `Restam ${cur.available} unidade(s)` : 'Disponível'}</p> : <span className="tag err">Indisponível</span>}
        <button className="btn block mt" disabled={!cur || cur.available < 1} onClick={() => { add({ skuId: cur.id, productName: p.name, variantName: cur.variantName, priceCents: cur.priceCents, imageUrl: photos[0] ?? cur.imageUrl ?? null, max: cur.available }); setDone(true); }}>
          Adicionar à sacola
        </button>
        {done && <Alert kind="ok">Adicionado! <Link to="/sacola">Ver sacola</Link></Alert>}
      </div>
    </>
  );
}
