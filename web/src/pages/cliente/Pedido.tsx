import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, FulTag, Loading, PayTag } from '../../components/ui';
import { get, post } from '../../lib/api';
import { brl, dt, hm } from '../../lib/format';
import { errMsg, useAsync, useInterval } from '../../lib/hooks';

function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), 1000);
  const s = Math.max(0, Math.floor((new Date(to).getTime() - now) / 1000));
  return <b aria-live="off">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</b>;
}

export default function Pedido() {
  const { id } = useParams();
  const { data: o, error, loading, reload, setData } = useAsync(() => get(`/api/orders/${id}`), [id]);
  const cfg = useAsync(() => get('/api/config'));
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = o?.paymentStatus === 'pendente' && o?.paymentMethod !== 'local';
  const localPending = o?.paymentStatus === 'pendente' && o?.paymentMethod === 'local';

  // Enquanto aguarda: pergunta ao servidor (que consulta o provedor). Quem confirma é o provedor, nunca o cliente.
  useInterval(() => { if (localPending) void reload(true); }, localPending ? 15000 : null);
  useInterval(() => { if (pending) post(`/api/orders/${id}/refresh`).then(setData).catch(() => undefined); }, pending ? 5000 : null);
  useEffect(() => { if (!pending) return; const f = () => { if (document.visibilityState === 'visible') void reload(true); }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [pending, reload]);

  if (loading) return <Loading />;
  if (error || !o) return <Alert>{error ?? 'Pedido não encontrado.'}</Alert>;

  const copy = async () => { try { await navigator.clipboard.writeText(o.pix.brcode); setMsg({ k: 'ok', t: 'Código Pix copiado. Cole no app do seu banco.' }); } catch { setMsg({ k: 'err', t: 'Não consegui copiar. Selecione o código e copie manualmente.' }); } };
  const cancel = async () => { if (!confirm('Cancelar este pedido e liberar os itens?')) return; setBusy(true); try { setData(await post(`/api/orders/${id}/cancel`)); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } finally { setBusy(false); } };
  const simulate = async () => { setBusy(true); try { await post(`/api/dev/orders/${id}/simulate-payment`); await reload(true); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } finally { setBusy(false); } };

  return (
    <>
      <p><Link to="/pedidos">← Meus pedidos</Link></p>
      <h1>Pedido #{o.number}</h1>
      <div className="row"><PayTag s={o.paymentStatus} /><FulTag s={o.fulfillmentStatus} /></div>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}

      {pending && o.pix && (
        <div className="card center">
          <h2>Pague com Pix</h2>
          <p>Valor: <b className="price">{brl(o.pix.amountCents)}</b></p>
          <img className="qr" src={o.pix.qrDataUrl} alt="QR Code do Pix" />
          <p>Vence em <Countdown to={o.pix.expiresAt} /> · seus itens estão reservados até {hm(o.pix.expiresAt)}</p>
          <div className="copia" aria-label="Pix Copia e Cola">{o.pix.brcode}</div>
          <button className="btn block mt" onClick={copy}>Copiar código Pix</button>
          <p className="muted">Estamos acompanhando o pagamento. Esta tela atualiza sozinha quando o banco confirmar. Enviar comprovante não confirma o pedido.</p>
          {o.pix.simulated && (
            <Alert kind="info">Pix <b>simulado</b> (demonstração): nenhum dinheiro real é cobrado.
              <button className="btn rosa sm" style={{ marginLeft: '.5rem' }} disabled={busy} onClick={simulate}>Simular pagamento</button></Alert>
          )}
          <button className="btn sec sm" disabled={busy} onClick={cancel}>Cancelar pedido</button>
        </div>
      )}
      {localPending && (
        <div className="card">
          <h2>Pedido enviado</h2>
          <p>Pague na {o.deliveryMode === 'retirada' ? 'retirada' : 'entrega'}: <b className="price">{brl(o.totalCents)}</b></p>
          <p className="muted">Seus itens estão reservados até {dt(o.reservationExpiresAt)}. A loja confirma o pagamento e o pedido entra na separação. Esta tela atualiza quando isso acontecer.</p>
          {cfg.data?.loja?.whatsapp && <p><a className="btn sm" target="_blank" rel="noopener" href={`https://wa.me/${cfg.data.loja.whatsapp}?text=${encodeURIComponent(`Olá! Segue o comprovante de pagamento do pedido #${o.number}.`)}`}>Enviar comprovante pelo WhatsApp</a></p>}
          <p className="muted">O comprovante enviado por WhatsApp ajuda a loja a conferir, mas quem confirma o pagamento é a equipe no painel.</p>
          <button className="btn sec sm" disabled={busy} onClick={cancel}>Cancelar pedido</button>
        </div>
      )}
      {pending && !o.pix && <Alert kind="warn">Pix indisponível no momento. Atualize a página ou tente novamente em instantes.</Alert>}
      {o.paymentStatus === 'expirado' && <Alert kind="warn">O prazo venceu e os itens foram liberados. Se você já pagou, o valor será conferido pela loja — fale com a gente.</Alert>}
      {o.fulfillmentStatus === 'em_analise' && <Alert kind="warn">Recebemos seu pagamento, mas a loja precisa conferir a disponibilidade dos itens. Entraremos em contato.</Alert>}

      <div className="card">
        <h3>Itens</h3>
        {o.items.map((i: any) => <div className="total" key={i.id}><span>{i.quantity}× {i.productName}{i.variantName !== 'Único' ? ` (${i.variantName})` : ''}</span><span>{brl(i.lineTotalCents)}</span></div>)}
        <div className="total"><span>Subtotal</span><span>{brl(o.subtotalCents)}</span></div>
        {o.discountCents > 0 && <div className="total"><span>Desconto Pix</span><span>− {brl(o.discountCents)}</span></div>}
        <div className="total"><span>Frete</span><span>{o.deliveryMode === 'retirada' ? 'Grátis' : brl(o.shippingCents)}</span></div>
        <div className="total big"><span>Total</span><span>{brl(o.totalCents)}</span></div>
        <p className="muted">{o.deliveryMode === 'retirada' ? 'Retirada na loja' : `Entrega — ${o.shippingZoneName ?? ''}`} · {o.etaText}</p>
        {o.address && <p className="muted">{o.address.street}, {o.address.number} — {o.address.neighborhood}</p>}
      </div>

      <div className="card">
        <h3>Acompanhamento</h3>
        <ul className="timeline">
          {o.timeline.map((t: any, i: number) => <li key={i}><b>{t.note}</b><div className="muted">{dt(t.createdAt)}</div></li>)}
        </ul>
      </div>
    </>
  );
}
