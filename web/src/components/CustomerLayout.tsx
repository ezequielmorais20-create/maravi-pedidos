import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';

export default function CustomerLayout() {
  const { user, isStaff } = useAuth();
  const { count } = useCart();
  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');
  return (
    <>
      <header className="topbar">
        <div className="in">
          <Link to="/"><img src="/logo-original.png" alt="MARAVI — Achadinhos e Variedades" /></Link>
          <span className="sp" />
          {isStaff && <Link className="btn sm sec" to="/painel">Painel</Link>}
        </div>
      </header>
      <div className="container"><Outlet /></div>
      <nav className="tabbar" aria-label="Navegação principal">
        <NavLink to="/" end className={tab}><span className="ico">🏠</span>Início</NavLink>
        <NavLink to="/catalogo" className={tab}><span className="ico">💄</span>Catálogo</NavLink>
        <NavLink to="/sacola" className={tab}><span className="ico">🛍️</span>Sacola{count > 0 && <span className="badge">{count}</span>}</NavLink>
        <NavLink to="/pedidos" className={tab}><span className="ico">📦</span>Meus pedidos</NavLink>
        <NavLink to="/conta" className={tab}><span className="ico">👤</span>{user ? 'Conta' : 'Entrar'}</NavLink>
      </nav>
    </>
  );
}
