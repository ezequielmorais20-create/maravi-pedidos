import { Link } from 'react-router-dom';
import { brl } from '../lib/format';
import { Img } from './ui';

export default function ProductCard({ p }: { p: any }) {
  const skus = (p.skus ?? []) as any[];
  const total = skus.reduce((a, s) => a + s.available, 0);
  const multi = new Set(skus.map((s) => s.priceCents)).size > 1;
  return (
    <Link to={`/produto/${p.id}`} className="prod" aria-label={`Ver ${p.name}`}>
      <div className="prod-media">
        <Img src={p.images?.[0] ?? skus[0]?.imageUrl} alt={p.name} />
        {total === 0 && <span className="prod-unavailable">Indisponível</span>}
      </div>
      <div className="b">
        <span className="prod-category">{p.category}</span>
        <div className="n">{p.name}</div>
        <div className="prod-bottom">
          <div className="price">{multi ? 'A partir de ' : ''}{brl(p.minPriceCents)}</div>
          <span className="prod-arrow" aria-hidden="true">→</span>
        </div>
      </div>
    </Link>
  );
}
