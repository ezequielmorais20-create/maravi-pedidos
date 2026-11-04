import { Link } from 'react-router-dom';
import ProductCard from '../../components/ProductCard';
import { Alert, Loading } from '../../components/ui';
import { get } from '../../lib/api';
import { useAsync } from '../../lib/hooks';

export default function Inicio() {
  const cfg = useAsync(() => get('/api/config'));
  const cats = useAsync(() => get('/api/catalog/categories'));
  const prods = useAsync(() => get('/api/catalog/products?sort=novos'));
  return (
    <>
      <div className="card" style={{ background: 'var(--vinho)', color: '#fff' }}>
        <h1 style={{ color: '#fff', marginBottom: '.3rem' }}>Achadinhos e Variedades</h1>
        <p style={{ margin: 0 }}>Maquiagem, cosméticos, acessórios e óculos. Monte sua sacola, pague com Pix e retire na loja ou receba em casa.</p>
        {cfg.data && <p className="muted" style={{ color: '#fbd5e0', marginBottom: 0 }}>{cfg.data.loja?.endereco}</p>}
      </div>
      {cfg.data && !cfg.data.pix.enabled && !cfg.data.pagamentoLocalAtivo && <Alert kind="warn">Nenhuma forma de pagamento está ativa no momento. Você pode montar a sacola, mas ainda não é possível finalizar.</Alert>}
      {cfg.data && !cfg.data.pix.enabled && cfg.data.pagamentoLocalAtivo && <Alert kind="info">Faça seu pedido e pague na retirada ou na entrega, combinado com a loja.</Alert>}
      {cfg.data?.pix.simulated && <Alert kind="info">Ambiente de demonstração: o Pix é simulado e nenhuma cobrança real é feita.</Alert>}
      <h2>Categorias</h2>
      <div className="row">
        {cats.data?.items.map((c: any) => <Link key={c.id} className="tag" to={`/catalogo?category=${c.slug}`}>{c.name}</Link>)}
      </div>
      <h2>Novidades</h2>
      {prods.loading ? <Loading /> : <div className="grid">{prods.data?.items.slice(0, 8).map((p: any) => <ProductCard key={p.id} p={p} />)}</div>}
      <p className="center mt"><Link className="btn" to="/catalogo">Ver todo o catálogo</Link></p>
    </>
  );
}
