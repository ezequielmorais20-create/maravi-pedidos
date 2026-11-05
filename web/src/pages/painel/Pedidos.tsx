import { useState } from 'react';
import { Alert, FulTag, Loading, PayTag } from '../../components/ui';
import { get } from '../../lib/api';
import { brl, hm, todayLocal } from '../../lib/format';
import { useAsync } from '../../lib/hooks';

const TZ = 'America/Fortaleza';
const diaDe = (v: string) => new Date(v).toLocaleDateString('sv-SE', { timeZone: TZ });
const diaLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const somaDias = (iso: string, n: number) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Todos os pedidos salvos, agrupados por dia, com dia/mês/ano e hora de cada um. */
export default function Pedidos() {
  const hoje = todayLocal();
  const [from, setFrom] = useState(somaDias(hoje, -29));
  const [to, setTo] = useState(hoje);
  const r = useAsync(() => get(`/api/staff/pedidos?from=${from}&to=${to}`), [from, to]);
  const items: any[] = r.data?.items ?? [];
  const grupos = new Map<string, any[]>();
  for (const o of items) { const d = diaDe(o.createdAt); grupos.set(d, [...(grupos.get(d) ?? []), o]); }
  const totalPagos = items.filter((o) => o.paymentStatus === 'pago').reduce((a, o) => a + (o.totalCents ?? 0), 0);
  return (
    <>
      <h1>Todos os pedidos</h1>
      <p className="muted">Todos os pedidos ficam salvos, em qualquer situação (pagos, aguardando, cancelados ou expirados), do mais recente ao mais antigo, com dia, mês e hora.</p>
      <div className="orders-filters">
        <div className="orders-date-range">
          <label className="orders-date-field">De<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label className="orders-date-field">Até<input type="date" value={to} min={from} max={hoje} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        </div>
        <div className="orders-presets">
          <button className="btn sm sec" onClick={() => { setFrom(hoje); setTo(hoje); }}>Hoje</button>
          <button className="btn sm sec" onClick={() => { setFrom(somaDias(hoje, -6)); setTo(hoje); }}>7 dias</button>
          <button className="btn sm sec" onClick={() => { setFrom(somaDias(hoje, -29)); setTo(hoje); }}>30 dias</button>
        </div>
      </div>
      {r.error && <Alert>{r.error}</Alert>}
      {r.loading ? <Loading /> : (
        <>
          <p><b>{items.length}</b> pedido(s) no período{r.data?.items?.[0]?.totalCents !== undefined && <> · pagos: <b>{brl(totalPagos)}</b></>}</p>
          {items.length === 0 && <p className="muted">Nenhum pedido neste período.</p>}
          {[...grupos.entries()].map(([dia, os]) => (
            <section key={dia} className="orders-day" style={{ marginBottom: '1.2rem' }}>
              <h2 style={{ textTransform: 'capitalize' }}>{diaLabel(dia)} <span className="muted" style={{ fontSize: '.8em' }}>· {os.length} pedido(s)</span></h2>
              <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label={`Pedidos de ${dia}; deslize horizontalmente para consultar todas as colunas`}><table className="panel-table-wide">
                <thead><tr><th>Hora</th><th>Pedido</th><th>Cliente</th><th>Itens</th><th>Entrega</th><th>Total</th><th>Status</th></tr></thead>
                <tbody>
                  {os.map((o) => (
                    <tr key={o.id}>
                      <td>{hm(o.createdAt)}</td>
                      <td><b>#{o.number}</b></td>
                      <td>{o.customerName}</td>
                      <td>{o.items?.map((x: any, j: number) => <div key={j}>{x.quantity}× {x.productName}{x.variantName !== 'Único' ? ` (${x.variantName})` : ''}</div>)}</td>
                      <td>{o.deliveryMode === 'retirada' ? 'Retirada' : `Entrega · ${o.shippingZoneName ?? ''}`}</td>
                      <td>{o.totalCents !== undefined ? brl(o.totalCents) : '—'}</td>
                      <td><PayTag s={o.paymentStatus} /> <FulTag s={o.fulfillmentStatus} />{o.paidAt && <div className="muted">pago às {hm(o.paidAt)}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
