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
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <p className="eyebrow">São Luís · Maranhão</p>
          <h1 id="home-title">Achadinhos e variedades para o seu dia</h1>
          <p>Maquiagem, cosméticos, acessórios e óculos. Escolha seus favoritos; a equipe confere o pedido e combina o pagamento com você. Retire na loja ou receba em casa.</p>
          <Link className="btn" to="/catalogo">Explorar catálogo <span aria-hidden="true">→</span></Link>
          {cfg.data?.loja?.endereco && <p className="hero-address">⌖ {cfg.data.loja.endereco}</p>}
        </div>
      </section>
      {cfg.data && !cfg.data.pix.enabled && !cfg.data.pagamentoLocalAtivo && <Alert kind="warn">Nenhuma forma de pagamento está ativa no momento. Você pode montar a sacola, mas ainda não é possível finalizar.</Alert>}
      {cfg.data && !cfg.data.pix.enabled && cfg.data.pagamentoLocalAtivo && <Alert kind="info">Faça seu pedido; a equipe confere os itens e combina o pagamento com você.</Alert>}
      {cfg.data?.pix.simulated && <Alert kind="info">Ambiente de demonstração: o Pix é simulado e nenhuma cobrança real é feita.</Alert>}
      <h2>Categorias para descobrir</h2>
      <div className="category-list">
        {cats.data?.items.map((c: any) => <Link key={c.id} className="tag" to={`/catalogo?category=${c.slug}`}>{c.name}<span aria-hidden="true"> ↗</span></Link>)}
      </div>
      <div className="row sb" style={{ marginTop: '1.7rem' }}>
        <h2 style={{ margin: 0 }}>Novidades</h2>
        <Link to="/catalogo">Ver catálogo <span aria-hidden="true">→</span></Link>
      </div>
      {prods.loading ? <Loading /> : <div className="grid" style={{ marginTop: '.85rem' }}>{prods.data?.items.slice(0, 8).map((p: any) => <ProductCard key={p.id} p={p} />)}</div>}
    </>
  );
}
