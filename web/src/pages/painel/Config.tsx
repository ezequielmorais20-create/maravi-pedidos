import { useState } from 'react';
import { Alert, Loading } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, dt, ROLE_LABEL } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';

export default function Config() {
  const { can } = useAuth();
  const r = useAsync(() => get('/api/staff/settings'));
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const edit = can('settings.edit');
  const [s, setS] = useState<any>(null);
  if (r.loading) return <Loading />;
  if (!r.data) return <Alert>{r.error}</Alert>;
  const cur = s ?? r.data.settings;
  const run = async (fn: () => Promise<any>, ok: string) => { setMsg(null); try { await fn(); setMsg({ k: 'ok', t: ok }); setS(null); await r.reload(true); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } };
  const pix = r.data.pix;
  return (
    <>
      <h1>Configurações</h1>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <Alert kind={pix.simulated ? 'warn' : pix.enabled ? 'ok' : 'err'}>
        Pix: <b>{pix.simulated ? 'SIMULADO (demonstração — não cobra de verdade)' : pix.enabled ? 'real' : 'desativado'}</b>. O modo é definido no servidor (variável PIX_MODE), não por esta tela.
      </Alert>
      <form className="card config-form" onSubmit={(e) => { e.preventDefault(); void run(() => put('/api/staff/settings', { loja: cur.loja, retiradaAtiva: cur.retiradaAtiva, entregaAtiva: cur.entregaAtiva, retiradaPrazo: cur.retiradaPrazo, reservaMinutos: Number(cur.reservaMinutos), descontoPixPercent: Number(cur.descontoPixPercent), pagamentoLocalAtivo: cur.pagamentoLocalAtivo, reservaLocalHoras: Number(cur.reservaLocalHoras) }), 'Configurações salvas.'); }}>
        <h3>Loja e pedidos</h3>
        <fieldset disabled={!edit} style={{ border: 0, padding: 0 }}>
          <label htmlFor="ln">Nome da loja</label><input id="ln" value={cur.loja.nome} onChange={(e) => setS({ ...cur, loja: { ...cur.loja, nome: e.target.value } })} />
          <label htmlFor="le">Endereço</label><input id="le" value={cur.loja.endereco} onChange={(e) => setS({ ...cur, loja: { ...cur.loja, endereco: e.target.value } })} />
          <label htmlFor="lw">WhatsApp</label><input id="lw" value={cur.loja.whatsapp} onChange={(e) => setS({ ...cur, loja: { ...cur.loja, whatsapp: e.target.value } })} />
          <label className="config-toggle"><input type="checkbox" checked={cur.retiradaAtiva} onChange={(e) => setS({ ...cur, retiradaAtiva: e.target.checked })} /> Retirada na loja ativa</label>
          <label className="config-toggle"><input type="checkbox" checked={cur.entregaAtiva} onChange={(e) => setS({ ...cur, entregaAtiva: e.target.checked })} /> Entrega ativa</label>
          <label htmlFor="lp">Prazo de retirada (texto mostrado ao cliente)</label><input id="lp" value={cur.retiradaPrazo} onChange={(e) => setS({ ...cur, retiradaPrazo: e.target.value })} />
          <label htmlFor="lr">Tempo de reserva do Pix (minutos, 5–120)</label><input id="lr" type="number" min={5} max={120} value={cur.reservaMinutos} onChange={(e) => setS({ ...cur, reservaMinutos: e.target.value })} />
          <label className="config-toggle"><input type="checkbox" checked={cur.pagamentoLocalAtivo} onChange={(e) => setS({ ...cur, pagamentoLocalAtivo: e.target.checked })} /> Permitir pagamento manual após conferência (a equipe envia o Pix e confirma o recebimento)</label>
          <label htmlFor="lh">Reserva dos itens enquanto a loja confere e aguarda pagamento (horas, 1–168)</label><input id="lh" type="number" min={1} max={168} value={cur.reservaLocalHoras} onChange={(e) => setS({ ...cur, reservaLocalHoras: e.target.value })} />
          <label htmlFor="ld">Desconto para pagamento no Pix (%, 0–30)</label><input id="ld" type="number" min={0} max={30} step="0.5" value={cur.descontoPixPercent} onChange={(e) => setS({ ...cur, descontoPixPercent: e.target.value })} />
        </fieldset>
        {edit && <button className="btn mt config-save">Salvar</button>}
      </form>
      <h2>Bairros, taxas e prazos de entrega</h2>
      {r.data.zones.map((z: any) => <Zone key={z.id} z={z} edit={edit} onSave={(body) => run(() => put(`/api/staff/zones/${z.id}`, body), 'Zona salva.')} />)}
      {edit && <Zone z={{ name: '', neighborhoods: [], feeCents: 0, etaMinMinutes: 30, etaMaxMinutes: 60, active: true, sortOrder: 99 }} edit isNew onSave={(body) => run(() => post('/api/staff/zones', body), 'Zona criada.')} />}
      {can('staff.manage') && <Team />}
      {can('audit.view') && <Audit />}
    </>
  );
}

function Zone({ z, edit, isNew, onSave }: { z: any; edit: boolean; isNew?: boolean; onSave: (b: any) => Promise<void> }) {
  const idBase = isNew ? 'nova' : String(z.id);
  const [f, setF] = useState({ name: z.name, nb: z.neighborhoods.join(', '), fee: String(z.feeCents / 100), min: String(z.etaMinMinutes), max: String(z.etaMaxMinutes), active: z.active });
  return (
    <form className="card zone-form" onSubmit={(e) => { e.preventDefault(); void onSave({ name: f.name, neighborhoods: f.nb.split(',').map((x: string) => x.trim()).filter(Boolean), feeCents: Math.round(Number(f.fee.replace(',', '.')) * 100), etaMinMinutes: Number(f.min), etaMaxMinutes: Number(f.max), active: f.active, sortOrder: z.sortOrder ?? 0 }); }}>
      <fieldset disabled={!edit} style={{ border: 0, padding: 0 }}>
        <b>{isNew ? 'Nova zona' : `${z.name} — ${brl(z.feeCents)}`}</b>
        <label htmlFor={`zone-name-${idBase}`}>Nome</label><input id={`zone-name-${idBase}`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <label htmlFor={`zone-neighborhoods-${idBase}`}>Bairros (separados por vírgula)</label><input id={`zone-neighborhoods-${idBase}`} value={f.nb} onChange={(e) => setF({ ...f, nb: e.target.value })} required />
        <div className="row zone-fields"><div className="zone-field"><label htmlFor={`zone-fee-${idBase}`}>Taxa (R$)</label><input id={`zone-fee-${idBase}`} inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></div><div className="zone-field"><label htmlFor={`zone-min-${idBase}`}>Prazo mín. (min)</label><input id={`zone-min-${idBase}`} type="number" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></div><div className="zone-field"><label htmlFor={`zone-max-${idBase}`}>Prazo máx. (min)</label><input id={`zone-max-${idBase}`} type="number" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></div></div>
        <label className="config-toggle"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativa</label>
      </fieldset>
      {edit && <button className="btn sm mt zone-save">{isNew ? 'Criar' : 'Salvar zona'}</button>}
    </form>
  );
}

function Team() {
  const t = useAsync(() => get('/api/staff/team'));
  const [f, setF] = useState({ name: '', email: '', role: 'atendimento', password: '' });
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const run = async (fn: () => Promise<any>, ok: string) => { setMsg(null); try { await fn(); setMsg({ k: 'ok', t: ok }); await t.reload(true); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } };
  return (
    <>
      <h2>Equipe</h2>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label="Equipe; deslize horizontalmente para consultar todas as colunas"><table className="panel-table-team"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th /></tr></thead>
        <tbody>{t.data?.items.map((u: any) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
            <td><select value={u.role} onChange={(e) => void run(() => put(`/api/staff/team/${u.id}`, { role: e.target.value }), 'Perfil atualizado.')}>{['administrador', 'atendimento', 'estoque'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td>
            <td>{u.active ? <span className="tag ok">ativo</span> : <span className="tag err">inativo</span>}</td>
            <td><button className="btn sm sec" onClick={() => void run(() => put(`/api/staff/team/${u.id}`, { active: !u.active }), u.active ? 'Acesso desativado.' : 'Acesso reativado.')}>{u.active ? 'Desativar' : 'Reativar'}</button></td></tr>
        ))}</tbody></table></div>
      <form className="card mt team-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post('/api/staff/team', f); setF({ name: '', email: '', role: 'atendimento', password: '' }); }, 'Usuário criado.'); }}>
        <h3>Novo usuário da equipe</h3>
        <label>Nome</label><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label>E-mail</label><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <label>Perfil</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['administrador', 'atendimento', 'estoque'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
        <label>Senha inicial (mín. 8)</label><input type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        <button className="btn mt">Criar</button>
      </form>
    </>
  );
}

function Audit() {
  const a = useAsync(() => get('/api/staff/audit?limit=100'));
  return (
    <>
      <h2>Trilha de auditoria</h2>
      {a.loading ? <Loading /> : (
        <div className="table-wrap panel-table-scroll" role="region" tabIndex={0} aria-label="Trilha de auditoria; deslize horizontalmente para consultar todas as colunas"><table className="panel-table-audit"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th></tr></thead>
          <tbody>{a.data?.items.map((x: any) => <tr key={x.id}><td>{dt(x.createdAt)}</td><td>{x.actorName} <span className="muted">{x.actorRole}</span></td><td>{x.action}</td><td className="muted" style={{ maxWidth: 360, wordBreak: 'break-word' }}>{x.details ? JSON.stringify(x.details) : ''}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}
