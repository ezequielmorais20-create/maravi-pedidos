import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Loading } from '../../components/ui';
import { get, post, qs, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dt } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';

type Op = 'entry' | 'adjust' | 'damage' | 'discard' | 'recover';
const OPS: Record<Op, string> = { entry: 'Entrada', adjust: 'Ajuste', damage: 'Registrar avaria', discard: 'Descartar', recover: 'Recuperar' };
const PERM: Record<Op, string> = { entry: 'stock.entry', adjust: 'stock.adjust', damage: 'stock.damage', discard: 'stock.damage', recover: 'stock.damage' };

export default function Estoque() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(sp.get('baixo') === '1');
  const [dmg, setDmg] = useState(sp.get('avaria') === '1');
  const list = useAsync(() => get(`/api/staff/stock${qs({ q, low: low ? 'true' : '', damaged: dmg ? 'true' : '' })}`), [q, low, dmg]);
  const ex = useAsync(() => get('/api/staff/exceptions'));
  const [form, setForm] = useState<{ op: Op; sku: any } | null>(null);
  const [hist, setHist] = useState<{ sku: any; rows: any[] } | null>(null);
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const refresh = () => { void list.reload(true); void ex.reload(true); };
  return (
    <>
      <h1>Estoque</h1>
      <p className="muted">Disponível = físico − reservado − avariado. Avaria mantém a unidade no físico, em quarentena; descarte a retira do físico.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      {(ex.data?.items?.length ?? 0) > 0 && (
        <Alert kind="err">
          <b>Exceções abertas ({ex.data.items.length})</b>
          {ex.data.items.map((e: any) => (
            <div key={e.id} className="row sb stock-exception" style={{ marginTop: '.4rem' }}>
              <span className="stock-exception-copy">Pedido #{e.orderNumber} — {e.productName} ({e.sku}) · {e.quantity} un. — {e.note}</span>
              {can('stock.resolve') && <button className="btn sm" onClick={async () => { const note = prompt('Como foi resolvido? (ex.: reposto, estornado)'); if (!note) return; try { await post(`/api/staff/exceptions/${e.id}/resolve`, { note }); setMsg({ k: 'ok', t: 'Exceção resolvida.' }); refresh(); } catch (x) { setMsg({ k: 'err', t: errMsg(x) }); } }}>Resolver</button>}
            </div>
          ))}
        </Alert>
      )}
      <div className="card row stock-filters">
        <div className="stock-search"><label htmlFor="eq">Buscar produto ou SKU</label><input id="eq" onBlur={(e) => setQ(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter') setQ((e.target as HTMLInputElement).value.trim()); }} /></div>
        <label className="stock-toggle"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Estoque baixo</label>
        <label className="stock-toggle"><input type="checkbox" checked={dmg} onChange={(e) => setDmg(e.target.checked)} /> Com avaria</label>
      </div>
      {list.loading ? <Loading /> : (
        <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label="Estoque de produtos; deslize horizontalmente para consultar quantidades e ações"><table className="panel-table-stock">
          <thead><tr><th>Produto</th><th>SKU</th><th className="n">Físico</th><th className="n">Reservado</th><th className="n">Avariado</th><th className="n">Disponível</th><th className="n">Mínimo</th><th /></tr></thead>
          <tbody>{list.data?.items.map((s: any) => (
            <tr key={s.id}>
              <td>{s.productName}{s.variantName !== 'Único' ? ` — ${s.variantName}` : ''}{s.lowStock && <> <span className="tag warn">baixo</span></>}{s.openExceptions > 0 && <> <span className="tag err">exceção</span></>}</td>
              <td>{s.sku}</td><td className="n">{s.physical}</td><td className="n">{s.reserved}</td><td className="n">{s.damaged}</td><td className="n"><b>{s.available}</b></td><td className="n">{s.minStock}</td>
              <td><div className="row stock-actions">
                {(Object.keys(OPS) as Op[]).filter((o) => can(PERM[o])).map((o) => <button key={o} className="btn sm sec" onClick={() => { setForm({ op: o, sku: s }); setMsg(null); }}>{OPS[o]}</button>)}
                <button className="btn sm sec" onClick={async () => setHist({ sku: s, rows: (await get(`/api/staff/stock/${s.id}/movements`)).items })}>Histórico</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {form && <MoveForm op={form.op} sku={form.sku} onDone={(t) => { setForm(null); setMsg({ k: 'ok', t }); refresh(); }} onCancel={() => setForm(null)} />}
      {hist && (
        <div className="card mt"><div className="row sb stock-history-header"><h3>Movimentações — {hist.sku.productName} ({hist.sku.sku})</h3><button className="btn sm sec" onClick={() => setHist(null)}>Fechar</button></div>
          <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label="Histórico de movimentações; deslize horizontalmente para consultar todas as colunas"><table className="panel-table-history"><thead><tr><th>Data</th><th>Tipo</th><th className="n">Qtd</th><th>Motivo</th><th>Usuário</th><th>Pedido</th></tr></thead>
            <tbody>{hist.rows.map((m: any) => <tr key={m.id}><td>{dt(m.createdAt)}</td><td>{m.kind}</td><td className="n">{m.quantity}</td><td>{m.reason}</td><td>{m.userName}</td><td>{m.orderNumber ? `#${m.orderNumber}` : '—'}</td></tr>)}</tbody></table></div></div>
      )}
    </>
  );
}

function MoveForm({ op, sku, onDone, onCancel }: { op: Op; sku: any; onDone: (t: string) => void; onCancel: () => void }) {
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState(op === 'entry' ? 'Entrada de mercadoria' : '');
  const [photo, setPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function upload(f: File) {
    const fd = new FormData(); fd.append('file', f);
    try { setPhoto((await api<{ url: string }>('POST', '/api/staff/uploads', fd)).url); } catch (e) { setErr(errMsg(e)); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const n = Number(qty);
    try {
      if (op === 'adjust') await post('/api/staff/stock/adjust', { skuId: sku.id, delta: n, reason });
      else await post(`/api/staff/stock/${op}`, { skuId: sku.id, quantity: n, reason, ...(op === 'damage' || op === 'discard' ? { photoUrl: photo } : {}) });
      onDone(`${OPS[op]} registrada.`);
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <form className="card mt stock-move-form" onSubmit={submit}>
      <h3>{OPS[op]} — {sku.productName}{sku.variantName !== 'Único' ? ` (${sku.variantName})` : ''}</h3>
      {err && <Alert>{err}</Alert>}
      <label htmlFor="mq">{op === 'adjust' ? 'Variação (+ ou −)' : 'Quantidade'}</label>
      <input id="mq" type="number" step={1} min={op === 'adjust' ? undefined : 1} required value={qty} onChange={(e) => setQty(e.target.value)} />
      <label htmlFor="mr">Motivo</label>
      <input id="mr" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      {(op === 'damage' || op === 'discard') && (<><label htmlFor="mf">Foto da avaria (opcional)</label><input id="mf" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />{photo && <p className="muted">Foto anexada.</p>}</>)}
      <div className="row mt stock-form-actions"><button className="btn" disabled={busy}>Confirmar</button><button type="button" className="btn sec" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}
