import { Link } from 'react-router-dom';
import { brl } from '../lib/format';
import { Img } from './ui';

export default function ProductCard({ p }: { p: any }) {
  const total = (p.skus as any[]).reduce((a, s) => a + s.available, 0);
  const multi = new Set((p.skus as any[]).map((s) => s.priceCents)).size > 1;
  return (
    <Link to={`/produto/${p.id}`} className="prod">
      <Img src={p.images?.[0] ?? p.skus?.[0]?.imageUrl} alt={p.name} />
      <div className="b">
        <div className="n">{p.name}</div>
        <div className="muted">{p.category}</div>
        <div className="price">{multi ? 'a partir de ' : ''}{brl(p.minPriceCents)}</div>
        {total === 0 && <span className="tag err">Indisponível</span>}
      </div>
    </Link>
  );
}
