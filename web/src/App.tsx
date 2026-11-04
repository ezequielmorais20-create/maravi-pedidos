import { Navigate, Route, Routes } from 'react-router-dom';
import CustomerLayout from './components/CustomerLayout';
import PanelLayout from './components/PanelLayout';
import Catalogo from './pages/cliente/Catalogo';
import Conta from './pages/cliente/Conta';
import Finalizar from './pages/cliente/Finalizar';
import Inicio from './pages/cliente/Inicio';
import Pedido from './pages/cliente/Pedido';
import Pedidos from './pages/cliente/Pedidos';
import Produto from './pages/cliente/Produto';
import Sacola from './pages/cliente/Sacola';
import Caixa from './pages/painel/Caixa';
import Config from './pages/painel/Config';
import Estoque from './pages/painel/Estoque';
import Fila from './pages/painel/Fila';
import TodosPedidos from './pages/painel/Pedidos';
import Produtos from './pages/painel/Produtos';
import Visao from './pages/painel/Visao';

export default function App() {
  return (
    <Routes>
      <Route element={<CustomerLayout />}>
        <Route index element={<Inicio />} />
        <Route path="catalogo" element={<Catalogo />} />
        <Route path="produto/:id" element={<Produto />} />
        <Route path="sacola" element={<Sacola />} />
        <Route path="finalizar" element={<Finalizar />} />
        <Route path="pedido/:id" element={<Pedido />} />
        <Route path="pedidos" element={<Pedidos />} />
        <Route path="conta" element={<Conta />} />
      </Route>
      <Route path="painel" element={<PanelLayout />}>
        <Route index element={<Visao />} />
        <Route path="fila" element={<Fila />} />
        <Route path="pedidos" element={<TodosPedidos />} />
        <Route path="caixa" element={<Caixa />} />
        <Route path="produtos" element={<Produtos />} />
        <Route path="estoque" element={<Estoque />} />
        <Route path="configuracoes" element={<Config />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
