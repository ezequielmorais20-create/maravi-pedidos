import { Link } from 'react-router-dom';
import { Alert, Loading } from '../../components/ui';
import { get } from '../../lib/api';
import { brl } from '../../lib/format';
import { useAsync, useInterval } from '../../lib/hooks';

export default function Visao() {
  const r = useAsync(() => get('/api/staff/dashboard'));
  useInterval(() => void r.reload(true), 15000);
  if (r.loading) return <Loading />;
  const d = r.data;
  if (!d) return <Alert>{r.error}</Alert>;
  const S = ({ l, v, to, warn }: { l: string; v: any; to?: string; warn?: boolean }) => {
    const inner = <div className="stat" style={warn && v > 0 ? { borderColor: 'var(--alerta)' } : undefined}><b>{v}</b>{l}</div>;
    return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link> : inner;
  };
  return (
    <>
      <h1>Visão geral</h1>
      <div className="stats">
        <S l="Na fila de separação" v={d.naFila} to="/painel/fila" />
        <S l="Em separação" v={d.emSeparacao} to="/painel/fila" />
        <S l="Prontos / em rota" v={d.prontosOuEmRota} to="/painel/fila" />
        <S l="Aguardando pagamento" v={d.aguardandoPix} to="/painel/fila?aba=aguardando" />
        <S l="Em análise" v={d.emAnalise} to="/painel/fila?aba=analise" warn />
        <S l="Exceções abertas" v={d.excecoesAbertas} to="/painel/fila?aba=excecoes" warn />
        <S l="Estoque baixo" v={d.estoqueBaixo} to="/painel/estoque?baixo=1" warn />
        <S l="Unidades em quarentena" v={d.unidadesEmQuarentena} to="/painel/estoque?avaria=1" />
        <S l="Pedidos pagos hoje" v={d.pagosHoje} />
      </div>
      {d.recebimentosHojeCents !== undefined && (
        <>
          <h2>Hoje (caixa do app)</h2>
          <div className="stats">
            <S l="Recebimentos Pix brutos" v={brl(d.recebimentosHojeCents)} />
            <S l="Movimento líquido do app" v={brl(d.movimentoLiquidoHojeCents)} />
          </div>
          <p className="muted">Movimento líquido do app = recebimentos − taxas − estornos − saídas registradas aqui. Não é saldo bancário nem lucro.</p>
        </>
      )}
    </>
  );
}
