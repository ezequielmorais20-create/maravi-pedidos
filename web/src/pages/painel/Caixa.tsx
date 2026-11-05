import { useState } from 'react';
import { Alert, Loading } from '../../components/ui';
import { get, post, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, dt, reaisToCents, todayLocal } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';

const KIND: Record<string, string> = { recebimento: 'Recebimento Pix', estorno: 'Estorno', saida: 'Saída autorizada' };

export default function Caixa() {
  const { can } = useAuth();
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState('');
  const q = { from, to };
  const sum = useAsync(() => get(`/api/staff/cash/summary${qs(q)}`), [from, to]);
  const st = useAsync(() => get(`/api/staff/cash/statement${qs({ ...q, kind, order })}`), [from, to, kind, order]);
  const rec = useAsync(() => get(`/api/staff/cash/reconciliation${qs(q)}`), [from, to]);
  const [out, setOut] = useState({ v: '', d: '' });
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const s = sum.data;
  return (
    <>
      <h1>Caixa</h1>
      <Alert kind="info">Este caixa mostra o <b>movimento líquido registrado pelo app</b>. Ele não é o saldo da conta bancária nem o lucro da loja.</Alert>
      <div className="card cash-filters">
        <div className="cash-field cash-date"><label htmlFor="de">De</label><input id="de" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="cash-field cash-date"><label htmlFor="ate">Até</label><input id="ate" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="cash-field"><label htmlFor="tp">Tipo</label><select id="tp" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Todos</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="cash-field"><label htmlFor="pd">Pedido nº</label><input id="pd" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value.replace(/\D/g, ''))} /></div>
        <div className="cash-field cash-export"><a className="btn sec" aria-label="Exportar extrato filtrado em CSV" href={`/api/staff/cash/statement.csv${qs({ ...q, kind, order })}`}>Exportar CSV</a></div>
      </div>
      <h2 className="cash-summary-title">Resumo do período</h2>
      {sum.loading ? <Loading /> : s && (
        <div className="stats cash-stats" aria-label="Resumo do caixa">
          <div className="stat cash-stat"><span>Recebimentos brutos <small>({s.recebimentosQtd})</small></span><b>{brl(s.recebimentosBrutosCents)}</b></div>
          <div className="stat cash-stat"><span>Frete incluído nos recebimentos</span><b>{brl(s.freteCents)}</b></div>
          <div className="stat cash-stat"><span>Descontos concedidos</span><b>{brl(s.descontosCents)}</b></div>
          <div className="stat cash-stat"><span>Taxas do provedor</span><b>{brl(s.taxasCents)}</b></div>
          <div className="stat cash-stat"><span>Estornos</span><b>{brl(s.estornosCents)}</b></div>
          <div className="stat cash-stat"><span>Saídas autorizadas</span><b>{brl(s.saidasCents)}</b></div>
          <div className="stat cash-stat cash-net"><span>Movimento líquido do app</span><b>{brl(s.movimentoLiquidoAppCents)}</b></div>
        </div>
      )}
      <h2>Extrato</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Data</th><th>Tipo</th><th>Pedido</th><th>Descrição</th><th className="n">Bruto</th><th className="n">Taxa</th><th className="n">Movimento</th></tr></thead>
        <tbody>
          {st.data?.items.length === 0 && <tr><td colSpan={7} className="muted center">Sem lançamentos no período.</td></tr>}
          {st.data?.items.map((e: any, i: number) => <tr key={i}><td>{dt(e.occurredAt)}</td><td>{KIND[e.kind]}</td><td>{e.orderNumber ? `#${e.orderNumber}` : '—'}</td><td>{e.description}</td><td className="n">{brl(e.grossCents)}</td><td className="n">{brl(e.feeCents)}</td><td className="n">{brl(e.movementCents)}</td></tr>)}
        </tbody>
      </table></div>
      {can('cash.manage') && (
        <form className="card mt" onSubmit={async (e) => { e.preventDefault(); setMsg(null); try { await post('/api/staff/cash/outflows', { amountCents: reaisToCents(out.v), description: out.d }); setOut({ v: '', d: '' }); setMsg({ k: 'ok', t: 'Saída registrada.' }); await Promise.all([sum.reload(true), st.reload(true)]); } catch (x) { setMsg({ k: 'err', t: errMsg(x) }); } }}>
          <h3>Registrar saída autorizada</h3>
          {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
          <div className="row"><div><label htmlFor="sv">Valor (R$)</label><input id="sv" inputMode="decimal" required value={out.v} onChange={(e) => setOut({ ...out, v: e.target.value })} /></div><div style={{ flex: 1 }}><label htmlFor="sd">Descrição</label><input id="sd" required minLength={3} value={out.d} onChange={(e) => setOut({ ...out, d: e.target.value })} /></div></div>
          <button className="btn mt">Registrar</button>
        </form>
      )}
      <h2>Conciliação com o provedor</h2>
      {rec.loading ? <Loading /> : rec.data && (
        <div className="card">
          {!rec.data.providerAvailable && <Alert kind="warn">Não foi possível consultar o provedor agora. Tente novamente.</Alert>}
          <p>Provedor: <b>{brl(rec.data.providerTotalCents)}</b> · App: <b>{brl(rec.data.appTotalCents)}</b></p>
          {rec.data.divergences === 0 ? <Alert kind="ok">Nenhuma divergência no período.</Alert> : <Alert kind="warn">{rec.data.divergences} divergência(s) — veja abaixo.</Alert>}
          <div className="table-wrap"><table>
            <thead><tr><th>Cobrança</th><th>Pedido</th><th className="n">Provedor</th><th className="n">App</th><th>Situação</th></tr></thead>
            <tbody>{rec.data.items.map((x: any) => <tr key={x.providerChargeId}><td>{x.providerChargeId}</td><td>{x.orderNumber ? `#${x.orderNumber}` : '—'}</td><td className="n">{x.providerAmountCents == null ? '—' : brl(x.providerAmountCents)}</td><td className="n">{x.appAmountCents == null ? '—' : brl(x.appAmountCents)}</td><td>{x.status === 'ok' ? <span className="tag ok">Conferido</span> : <span className="tag err">{x.status === 'so_no_provedor' ? 'Só no provedor' : x.status === 'so_no_app' ? 'Só no app' : 'Valor diferente'}</span>}</td></tr>)}</tbody>
          </table></div>
          {rec.data.lateOrders.length > 0 && <p className="muted">Pix tardio: {rec.data.lateOrders.map((o: any) => `#${o.number}`).join(', ')}</p>}
          {rec.data.rejectedEvents.length > 0 && <p className="muted">Eventos rejeitados/ignorados no período: {rec.data.rejectedEvents.length} (ver trilha de auditoria).</p>}
        </div>
      )}
    </>
  );
}
