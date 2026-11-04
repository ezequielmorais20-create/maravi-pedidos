import { Link, useNavigate } from 'react-router-dom';
import { Empty, Img } from '../../components/ui';
import { useCart } from '../../lib/cart';
import { brl } from '../../lib/format';

export default function Sacola() {
  const { lines, setQty, remove } = useCart();
  const nav = useNavigate();
  const sub = lines.reduce((a, l) => a + l.priceCents * l.quantity, 0);
  if (!lines.length) return <><h1>Sacola</h1><Empty>Sua sacola está vazia. <Link to="/catalogo">Ver o catálogo</Link></Empty></>;
  return (
    <>
      <h1>Sacola</h1>
      <div className="card">
        {lines.map((l) => (
          <div className="line" key={l.skuId}>
            <Img src={l.imageUrl} alt={l.productName} />
            <div className="g">
              <div style={{ fontWeight: 600 }}>{l.productName}</div>
              <div className="muted">{l.variantName !== 'Único' ? l.variantName : ''}</div>
              <div className="price">{brl(l.priceCents)}</div>
              <div className="qty">
                <button aria-label="Diminuir" onClick={() => setQty(l.skuId, l.quantity - 1)}>−</button>
                <span aria-live="polite">{l.quantity}</span>
                <button aria-label="Aumentar" onClick={() => setQty(l.skuId, l.quantity + 1)} disabled={l.quantity >= l.max}>+</button>
                <button className="btn sec sm" style={{ width: 'auto', height: 'auto', marginLeft: '.5rem' }} onClick={() => remove(l.skuId)}>Remover</button>
              </div>
            </div>
            <div className="price">{brl(l.priceCents * l.quantity)}</div>
          </div>
        ))}
        <div className="total big"><span>Subtotal</span><span>{brl(sub)}</span></div>
        <p className="muted">Frete e desconto Pix aparecem na próxima etapa, antes do pagamento. Preço e estoque são conferidos de novo ao finalizar.</p>
      </div>
      <button className="btn block" onClick={() => nav('/finalizar')}>Continuar</button>
    </>
  );
}
