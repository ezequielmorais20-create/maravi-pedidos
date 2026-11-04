import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, FulTag, Loading, PayTag } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, dt, hm } from '../../lib/format';
import { errMsg, useAsync, useInterval } from '../../lib/hooks';

const TABS: [string, string][] = [['fila', 'Fila de separação'], ['aguardando', 'Aguardando pagamento'], ['analise', 'Em análise'], ['excecoes', 'Exceções'], ['historico', 'Histórico']];
const NEXT: Record<string, [string, string][]> = {
  pago: [['em_separacao', 'Iniciar separação']],
  em_separacao: [['pronto_retirada', 'Pronto p/ retirada'], ['saiu_entrega', 'Saiu p/ entrega']],
  pronto_retirada: [['concluido', 'Concluir']],
  saiu_entrega: [['concluido', 'Concluir']],
};

export default function Fila() {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('aba') ?? 'fila';
  const r = useAsync(() => get(`/api/staff/orders?view=${view}`), [view]);
  useInterval(() => void r.reload(true), 10000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <h1>Fila de pedidos</h1>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => { setSp({ aba: k }); setOpen(null); }}>{l}</button>)}</div>
      {view === 'fila' && <p className="muted">Ordem: horário em que o banco confirmou o Pix (mais antigo primeiro) — não a ordem de criação do pedido.</p>}
      {r.error && <Alert>{r.error}</Alert>}
      {r.loading ? <Loading /> : (
        <div className="table-wrap"><table>
          <thead><tr>{view === 'fila' && <th>#</th>}<th>Pedido</th><th>Cliente</th><th>Itens</th><th>Entrega</th><th>{view === 'aguardando' ? 'Reserva até' : 'Pago às'}</th><th>Status</th><th /></tr></thead>
          <tbody>
            {r.data?.items.length === 0 && <tr><td colSpan={8} className="muted center">Nada por aqui.</td></tr>}
            {r.data?.items.map((o: any, i: number) => (
              <tr key={o.id}>
                {view === 'fila' && <td>{i + 1}º</td>}
                <td><b>#{o.number}</b>{o.latePayment && <div><span className="tag warn">Pix tardio</span></div>}{o.hasException && <div><span className="tag err">Exceção</span></div>}</td>
                <td>{o.customerName}</td>
                <td>{o.items?.map((x: any, j: number) => <div key={j}>{x.quantity}× {x.productName}{x.variantName !== 'Único' ? ` (${x.variantName})` : ''}</div>)}</td>
                <td>{o.deliveryMode === 'retirada' ? 'Retirada' : `Entrega · ${o.shippingZoneName ?? ''}`}</td>
                <td>{view === 'aguardando' ? hm(o.reservationExpiresAt) : dt(o.paidAt)}{o.paymentMethod === 'local' && <div><span className="tag">pagamento manual</span></div>}</td>
                <td><PayTag s={o.paymentStatus} /> <FulTag s={o.fulfillmentStatus} /></td>
                <td><button className="btn sm sec" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? 'Fechar' : 'Abrir'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {open && <OrderDetail id={open} onChanged={() => void r.reload(true)} />}
    </>
  );
}

function OrderDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const r = useAsync(() => get(`/api/staff/orders/${id}`), [id]);
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pmethod, setPmethod] = useState('dinheiro');
  const o = r.data;
  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true); setMsg(null);
    try { const res = await fn(); if (res?.id) r.setData(res); else if (res?.order) r.setData(res.order); else await r.reload(true); setMsg({ k: 'ok', t: ok }); onChanged(); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } finally { setBusy(false); }
  };
  if (r.loading) return <Loading />;
  if (!o) return <Alert>{r.error}</Alert>;
  const openEx = (o.exceptions ?? []).filter((e: any) => e.status === 'aberta');
  const rawPhone = String(o.customerPhone ?? '').replace(/\D/g, '');
  const phoneDigits = rawPhone.startsWith('0') ? rawPhone.slice(1) : rawPhone;
  const waNumber = phoneDigits.startsWith('55') && [12, 13].includes(phoneDigits.length)
    ? phoneDigits
    : [10, 11].includes(phoneDigits.length) ? `55${phoneDigits}` : '';
  const waMessage = `Olá, ${o.customerName}! Conferimos seu pedido #${o.number} da MARAVI. Total: ${brl(o.totalCents)}. Seguem os dados para pagamento via Pix: `;
  return (
    <div className="card mt">
      <div className="row sb"><h2 style={{ margin: 0 }}>Pedido #{o.number}</h2><span><PayTag s={o.paymentStatus} /> <FulTag s={o.fulfillmentStatus} /></span></div>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      {o.customerName && <p><b>{o.customerName}</b>{o.customerPhone ? ` · ${o.customerPhone}` : ''}{o.customerEmail ? ` · ${o.customerEmail}` : ''}</p>}
      {o.deliveryMode === 'entrega' && o.address && <p>Entrega: {o.address.recipient} — {o.address.street}, {o.address.number}{o.address.complement ? ` (${o.address.complement})` : ''} · {o.address.neighborhood}{o.address.reference ? ` · Ref.: ${o.address.reference}` : ''}</p>}
      {o.deliveryMode === 'retirada' && <p>Retirada na loja.</p>}
      {o.analysisReason && <Alert kind="warn">Em análise: {o.analysisReason}</Alert>}
      {openEx.map((e: any) => <Alert key={e.id} kind="err">Exceção aberta — {e.productName} ({e.sku}), {e.quantity} un.: {e.note}. A expedição fica bloqueada até repor o estoque ou estornar.</Alert>)}
      <table><tbody>{o.items.map((i: any) => <tr key={i.id}><td>{i.quantity}×</td><td>{i.productName}{i.variantName !== 'Único' ? ` (${i.variantName})` : ''} <span className="muted">{i.skuCode}</span></td>{i.lineTotalCents !== undefined && <td className="n">{brl(i.lineTotalCents)}</td>}</tr>)}</tbody></table>
      {o.totalCents !== undefined && <p>Subtotal {brl(o.subtotalCents)} · Desconto {brl(o.discountCents)} · Frete {brl(o.shippingCents)} · <b>Total {brl(o.totalCents)}</b></p>}
      {o.paymentStatus === 'pendente' && o.paymentMethod === 'local' && <Alert kind="info">Pedido aguardando pagamento manual. Confira os itens, a disponibilidade e o total; envie a chave ou o link Pix pelo WhatsApp. Confirme abaixo somente depois de verificar o recebimento.</Alert>}
      {can('orders.review') && o.paymentStatus === 'pendente' && o.paymentMethod === 'local' && (waNumber ? <div className="mt"><a className="btn sec" target="_blank" rel="noopener noreferrer" href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`}>Preparar mensagem de Pix no WhatsApp</a><p className="muted">O WhatsApp abrirá um rascunho. Confira o valor, inclua a chave ou o link Pix e toque em enviar.</p></div> : <Alert kind="warn">Não há telefone/WhatsApp válido no cadastro da cliente. Solicite o contato antes de enviar os dados do Pix.</Alert>)}
      {o.payment && o.payment.method !== 'pix' && <p className="muted">Pago em {{ dinheiro: 'dinheiro', cartao: 'cartão', pix_loja: 'Pix direto na conta da loja', outro: 'outra forma' }[o.payment.method as string]} · confirmado por {o.payment.confirmedByName} em {dt(o.payment.settledAt)}</p>}
      {o.payment && o.payment.method === 'pix' && <p className="muted">Pix liquidado em {dt(o.payment.settledAt)} (recebido pelo app em {dt(o.payment.receivedAt)}) · cobrança {o.payment.providerChargeId}{o.payment.simulated ? ' · SIMULADO' : ''}</p>}
      {(o.refunds ?? []).map((f: any) => <p key={f.id} className="muted">Estorno {brl(f.amountCents)} — {f.status} — {f.reason}</p>)}
      <div className="row">
        {can('orders.advance') && (NEXT[o.fulfillmentStatus] ?? []).filter(([to]) => !(to === 'saiu_entrega' && o.deliveryMode !== 'entrega') && !(to === 'pronto_retirada' && o.deliveryMode !== 'retirada')).map(([to, l]) => <button key={to} className="btn" disabled={busy || openEx.length > 0} onClick={() => act(() => post(`/api/staff/orders/${id}/advance`, { to }), 'Status atualizado.')}>{l}</button>)}
        {can('orders.confirm_payment') && o.paymentStatus === 'pendente' && o.paymentMethod === 'local' && (
          <span className="row">
            <select value={pmethod} onChange={(e) => setPmethod(e.target.value)} aria-label="Forma de pagamento recebida" style={{ width: 'auto' }}>
              <option value="dinheiro">Dinheiro</option><option value="cartao">Cartão</option><option value="pix_loja">Pix direto na conta da loja</option><option value="outro">Outra forma</option>
            </select>
            <button className="btn" disabled={busy} onClick={() => { if (confirm(`Confirmar que recebeu ${brl(o.totalCents)} deste pedido?`)) void act(() => post(`/api/staff/orders/${id}/confirm-payment`, { method: pmethod }), 'Pagamento confirmado. O pedido entrou na fila.'); }}>Confirmar pagamento recebido</button>
          </span>
        )}
        {can('orders.review') && o.fulfillmentStatus === 'em_analise' && <button className="btn" disabled={busy} onClick={() => act(() => post(`/api/staff/orders/${id}/release`), 'Liberado para separação.')}>Liberar para separação (estoque garantido)</button>}
        {can('orders.review') && o.paymentStatus === 'pendente' && <button className="btn sec" disabled={busy} onClick={() => { if (confirm('Cancelar pedido não pago e liberar a reserva?')) void act(() => post(`/api/staff/orders/${id}/cancel`), 'Pedido cancelado.'); }}>Cancelar (não pago)</button>}
        {can('orders.refund') && o.paymentStatus === 'pago' && <button className="btn danger" disabled={busy} onClick={() => { const reason = prompt('Motivo do estorno (obrigatório):'); if (!reason) return; const restock = confirm('Devolver os itens ao estoque disponível?\nOK = sim, Cancelar = não.'); void act(() => post(`/api/staff/orders/${id}/refund`, { reason, restock }), 'Estorno solicitado.'); }}>Estornar</button>}
      </div>
      <h3>Histórico</h3>
      <ul className="timeline">{o.events.map((e: any, i: number) => <li key={i}>{e.note} <span className="muted">— {e.actorName ?? 'sistema'} · {dt(e.createdAt)}</span></li>)}</ul>
    </div>
  );
}
