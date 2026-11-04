import { Link } from 'react-router-dom';
import { Alert, Empty, FulTag, Loading, PayTag } from '../../components/ui';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, dt } from '../../lib/format';
import { useAsync } from '../../lib/hooks';

export default function Pedidos() {
  const { user } = useAuth();
  const r = useAsync(() => (user ? get('/api/orders') : Promise.resolve({ items: [] })), [user?.id]);
  if (!user) return <><h1>Meus pedidos</h1><Alert kind="info"><Link to="/conta?voltar=/pedidos">Entre na sua conta</Link> para ver seus pedidos.</Alert></>;
  if (r.loading) return <Loading />;
  return (
    <>
      <h1>Meus pedidos</h1>
      {r.error && <Alert>{r.error}</Alert>}
      {r.data?.items.length === 0 && <Empty>Você ainda não fez pedidos.</Empty>}
      {r.data?.items.map((o: any) => (
        <Link key={o.id} to={`/pedido/${o.id}`} className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <div className="row sb"><b>Pedido #{o.number}</b><span className="price">{brl(o.totalCents)}</span></div>
          <div className="muted">{dt(o.createdAt)}</div>
          <div className="row"><PayTag s={o.paymentStatus} /><FulTag s={o.fulfillmentStatus} /></div>
        </Link>
      ))}
    </>
  );
}
