import { Link, NavLink, Navigate, Outlet } from 'react-router-dom';
import { Loading } from './ui';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/format';

const ITEMS: [string, string, string][] = [
  ['/painel', 'Visão geral', 'dashboard.view'],
  ['/painel/fila', 'Fila de pedidos', 'orders.view'],
  ['/painel/pedidos', 'Todos os pedidos', 'orders.view'],
  ['/painel/caixa', 'Caixa', 'cash.view'],
  ['/painel/produtos', 'Produtos', 'products.view'],
  ['/painel/estoque', 'Estoque', 'stock.view'],
  ['/painel/configuracoes', 'Configurações', 'settings.view'],
];

export default function PanelLayout() {
  const { user, loading, can, logout } = useAuth();
  if (loading) return <Loading />;
  if (!user || user.role === 'cliente') return <Navigate to="/conta?voltar=/painel" replace />;
  return (
    <div className="pnl">
      <nav aria-label="Painel">
        <img src="/logo-maravi.png" alt="MARAVI" />
        {ITEMS.filter(([, , p]) => can(p)).map(([to, l]) => <NavLink key={to} to={to} end={to === '/painel'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}
        <div className="who" style={{ position: 'absolute', bottom: '1rem', left: '.8rem', right: '.8rem', fontSize: '.8rem' }}>
          <div>{user.name}<br /><span style={{ opacity: .8 }}>{ROLE_LABEL[user.role]}</span></div>
          <Link to="/" style={{ display: 'inline', padding: 0, color: '#fbd5e0' }}>Ver loja</Link> · <a href="#" style={{ display: 'inline', padding: 0, color: '#fbd5e0' }} onClick={(e) => { e.preventDefault(); void logout(); }}>Sair</a>
        </div>
      </nav>
      <main><Outlet /></main>
    </div>
  );
}
