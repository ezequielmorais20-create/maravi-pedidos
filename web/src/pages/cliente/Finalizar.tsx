import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Empty, Loading } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { brl } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';
import AddressForm from './AddressForm';

export default function Finalizar() {
  const { user } = useAuth();
  const { lines, clear } = useCart();
  const nav = useNavigate();
  const cfg = useAsync(() => get('/api/config'));
  const addrs = useAsync(() => (user ? get('/api/me/addresses') : Promise.resolve({ items: [] })), [user?.id]);
  const [mode, setMode] = useState<'retirada' | 'entrega'>('retirada');
  const [method, setMethod] = useState<'pix' | 'local' | null>(null);
  const [addressId, setAddressId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Uma chave por tentativa de compra: repetir o clique não cria pedido duplicado.
  const idem = useRef(crypto.randomUUID());

  const pm: 'pix' | 'local' | null = method ?? (cfg.data ? (cfg.data.pix.enabled ? 'pix' : cfg.data.pagamentoLocalAtivo ? 'local' : null) : null);
  const items = useMemo(() => lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity })), [lines]);
  const list: any[] = addrs.data?.items ?? [];
  useEffect(() => { if (!addressId && list.length) setAddressId((list.find((a) => a.isDefault) ?? list[0]).id); }, [list, addressId]);

  useEffect(() => {
    if (!user || !items.length) return;
    if (mode === 'entrega' && !addressId) { setQuote(null); return; }
    let live = true;
    post('/api/checkout/quote', { items, deliveryMode: mode, addressId: mode === 'entrega' ? addressId : null, paymentMethod: pm ?? 'pix' })
      .then((q) => { if (live) { setQuote(q); setErr(null); } })
      .catch((e) => { if (live) { setQuote(null); setErr(errMsg(e)); } });
    return () => { live = false; };
  }, [user, items, mode, addressId, pm]);

  if (!lines.length) return <Empty>Sua sacola está vazia. <Link to="/catalogo">Ver o catálogo</Link></Empty>;
  if (!user) return <><h1>Finalizar</h1><Alert kind="info">Entre ou crie sua conta para finalizar. Sua sacola fica guardada. <Link to="/conta?voltar=/finalizar">Entrar / cadastrar</Link></Alert></>;
  if (cfg.loading) return <Loading />;
  const c = cfg.data;

  async function pay() {
    setBusy(true); setErr(null);
    try {
      const o = await post('/api/orders', { items, deliveryMode: mode, addressId: mode === 'entrega' ? addressId : null, paymentMethod: pm }, { 'Idempotency-Key': idem.current });
      clear();
      nav(`/pedido/${o.id}`, { replace: true });
    } catch (e) { setErr(errMsg(e)); idem.current = crypto.randomUUID(); } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Finalizar pedido</h1>
      {!pm && <Alert kind="warn">Nenhuma forma de pagamento está ativa no momento. Não é possível finalizar agora.</Alert>}
      <div className="card">
        <h3>Como você quer receber?</h3>
        <label><input type="radio" name="modo" checked={mode === 'retirada'} disabled={!c.retiradaAtiva} onChange={() => setMode('retirada')} /> Retirar na loja <span className="muted">— grátis. {c.retiradaPrazo}</span></label>
        <label><input type="radio" name="modo" checked={mode === 'entrega'} disabled={!c.entregaAtiva} onChange={() => setMode('entrega')} /> Entrega em casa <span className="muted">— frete por bairro</span></label>
        {mode === 'retirada' && <p className="muted">{c.loja?.endereco}</p>}
        {mode === 'entrega' && (
          <>
            {list.length > 0 && (
              <>
                <label htmlFor="end">Endereço de entrega</label>
                <select id="end" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                  {list.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.street}, {a.number} · {a.neighborhood}</option>)}
                </select>
              </>
            )}
            <p><button className="btn sec sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancelar' : 'Novo endereço'}</button></p>
            {adding && <AddressForm onSaved={async (a: any) => { setAdding(false); await addrs.reload(true); setAddressId(a.id); }} />}
            <details><summary className="muted">Bairros atendidos e fretes</summary>
              <ul>{c.zones.map((z: any) => <li key={z.id}>{z.name}: {brl(z.feeCents)} · {z.etaMinMinutes}–{z.etaMaxMinutes} min</li>)}</ul>
            </details>
          </>
        )}
      </div>
      {(c.pix.enabled || c.pagamentoLocalAtivo) && (
        <div className="card">
          <h3>Forma de pagamento</h3>
          {c.pix.enabled && <label><input type="radio" name="pgto" checked={pm === 'pix'} onChange={() => setMethod('pix')} /> Pix agora <span className="muted">— confirmação automática</span></label>}
          {c.pagamentoLocalAtivo && <label><input type="radio" name="pgto" checked={pm === 'local'} onChange={() => setMethod('local')} /> Pagar na {mode === 'retirada' ? 'retirada' : 'entrega'} <span className="muted">— combinado com a loja</span></label>}
          {pm === 'local' && <p className="muted">Seus itens ficam reservados por {c.reservaLocalHoras} h. A loja confirma o pagamento (dinheiro, cartão ou Pix direto com a loja) e o pedido entra na separação.</p>}
        </div>
      )}
      {err && <Alert>{err}</Alert>}
      {quote && (
        <div className="card">
          <h3>Resumo</h3>
          {quote.items.map((i: any) => (
            <div className="total" key={i.skuId}><span>{i.quantity}× {i.productName}{i.variantName !== 'Único' ? ` (${i.variantName})` : ''}{i.available < i.quantity && <span className="tag err"> sem estoque suficiente</span>}</span><span>{brl(i.lineTotalCents)}</span></div>
          ))}
          <div className="total"><span>Subtotal</span><span>{brl(quote.subtotalCents)}</span></div>
          {quote.discountCents > 0 && <div className="total"><span>Desconto Pix</span><span>− {brl(quote.discountCents)}</span></div>}
          <div className="total"><span>Frete{quote.zoneName ? ` (${quote.zoneName})` : ''}</span><span>{quote.deliveryMode === 'retirada' ? 'Grátis' : brl(quote.shippingCents)}</span></div>
          <div className="total big"><span>{pm === 'local' ? 'Total a pagar' : 'Total no Pix'}</span><span>{brl(quote.totalCents)}</span></div>
          <p className="muted">{quote.etaText}</p>
          <p className="muted">{pm === 'local' ? `Ao enviar, reservamos seus itens por ${quote.reservaLocalHoras} horas.` : `Ao pagar, reservamos seus itens por ${quote.reservaMinutos} minutos.`}</p>
        </div>
      )}
      <button className="btn block" disabled={busy || !quote || !quote.allAvailable || !pm} onClick={pay}>{busy ? 'Enviando…' : pm === 'local' ? 'Enviar pedido' : 'Pagar com Pix'}</button>
    </>
  );
}
