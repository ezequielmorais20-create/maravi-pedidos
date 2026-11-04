import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Loading } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ROLE_LABEL } from '../../lib/format';
import { errMsg, useAsync } from '../../lib/hooks';
import AddressForm from './AddressForm';

function AuthForms() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const back = sp.get('voltar') && sp.get('voltar')!.startsWith('/') ? sp.get('voltar')! : '/conta';
  const token = sp.get('token');
  const [tab, setTab] = useState<'entrar' | 'cadastrar' | 'esqueci' | 'redefinir'>(token ? 'redefinir' : 'entrar');
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '' });
  const [msg, setMsg] = useState<{ k: 'ok' | 'err' | 'info'; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function run(fn: () => Promise<any>) { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } finally { setBusy(false); } }
  const submit = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    if (tab === 'entrar') { await login(f.email, f.password); nav(back, { replace: true }); }
    else if (tab === 'cadastrar') { await register({ name: f.name, email: f.email, phone: f.phone || undefined, password: f.password }); nav(back, { replace: true }); }
    else if (tab === 'esqueci') { const r = await post('/api/auth/forgot', { email: f.email }); setMsg({ k: 'ok', t: r.message + (r.devLink ? ` (ambiente de desenvolvimento) Link: ${r.devLink}` : '') }); }
    else { await post('/api/auth/reset', { token, password: f.password }); setMsg({ k: 'ok', t: 'Senha alterada. Entre com a nova senha.' }); setTab('entrar'); }
  }); };
  return (
    <>
      <h1>{tab === 'entrar' ? 'Entrar' : tab === 'cadastrar' ? 'Criar conta' : tab === 'esqueci' ? 'Recuperar senha' : 'Nova senha'}</h1>
      <div className="tabs"><button className={tab === 'entrar' ? 'on' : ''} onClick={() => setTab('entrar')}>Entrar</button><button className={tab === 'cadastrar' ? 'on' : ''} onClick={() => setTab('cadastrar')}>Criar conta</button></div>
      <form className="card" onSubmit={submit}>
        {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
        {tab === 'cadastrar' && (<><label htmlFor="nome">Nome completo</label><input id="nome" value={f.name} onChange={set('name')} required minLength={2} autoComplete="name" /></>)}
        {tab !== 'redefinir' && (<><label htmlFor="email">E-mail</label><input id="email" type="email" value={f.email} onChange={set('email')} required autoComplete="email" /></>)}
        {tab === 'cadastrar' && (<><label htmlFor="tel">Telefone / WhatsApp</label><input id="tel" value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" /></>)}
        {tab !== 'esqueci' && (<><label htmlFor="senha">{tab === 'entrar' ? 'Senha' : 'Senha (mín. 8 caracteres)'}</label><input id="senha" type="password" value={f.password} onChange={set('password')} required minLength={tab === 'entrar' ? 1 : 8} autoComplete={tab === 'entrar' ? 'current-password' : 'new-password'} /></>)}
        <button className="btn block mt" disabled={busy}>{busy ? 'Aguarde…' : tab === 'entrar' ? 'Entrar' : tab === 'cadastrar' ? 'Criar conta' : tab === 'esqueci' ? 'Enviar instruções' : 'Salvar nova senha'}</button>
        {tab === 'entrar' && <p className="center"><a href="#" onClick={(e) => { e.preventDefault(); setTab('esqueci'); }}>Esqueci minha senha</a></p>}
      </form>
    </>
  );
}

function Profile() {
  const { user, logout } = useAuth();
  const addrs = useAsync(() => get('/api/me/addresses'));
  const [edit, setEdit] = useState<any | 'novo' | null>(null);
  const [name, setName] = useState(user!.name);
  const [phone, setPhone] = useState(user!.phone ?? '');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const nav = useNavigate();
  const run = async (fn: () => Promise<any>, ok: string) => { setMsg(null); try { await fn(); setMsg({ k: 'ok', t: ok }); } catch (e) { setMsg({ k: 'err', t: errMsg(e) }); } };
  return (
    <>
      <h1>Minha conta</h1>
      <p className="muted">{user!.email} · {ROLE_LABEL[user!.role]}</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(() => patch('/api/me', { name, phone: phone || null }), 'Dados atualizados. Recarregue para ver o novo nome no topo.'); }}>
        <h3>Meus dados</h3>
        <label htmlFor="pn">Nome</label><input id="pn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        <label htmlFor="pt">Telefone</label><input id="pt" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        <button className="btn mt">Salvar</button>
      </form>
      {user!.role === 'cliente' && (
        <div className="card">
          <div className="row sb"><h3>Endereços</h3><button className="btn sm sec" onClick={() => setEdit('novo')}>Adicionar</button></div>
          {addrs.loading ? <Loading /> : addrs.data?.items.length === 0 && <p className="muted">Nenhum endereço cadastrado.</p>}
          {addrs.data?.items.map((a: any) => (
            <div key={a.id} className="line"><div className="g"><b>{a.label}</b> {a.isDefault && <span className="tag">padrão</span>}<div className="muted">{a.street}, {a.number} — {a.neighborhood}</div></div>
              <button className="btn sec sm" onClick={() => setEdit(a)}>Editar</button>
              <button className="btn sec sm" onClick={() => { if (confirm('Excluir este endereço?')) void del(`/api/me/addresses/${a.id}`).then(() => addrs.reload(true)).catch((e) => setMsg({ k: 'err', t: errMsg(e) })); }}>Excluir</button></div>
          ))}
          {edit && <AddressForm initial={edit === 'novo' ? undefined : edit} onSaved={async () => { setEdit(null); await addrs.reload(true); }} />}
        </div>
      )}
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post('/api/me/password', pw); setPw({ current: '', next: '' }); }, 'Senha alterada. Os outros aparelhos foram desconectados.'); }}>
        <h3>Trocar senha</h3>
        <label htmlFor="pa">Senha atual</label><input id="pa" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required autoComplete="current-password" />
        <label htmlFor="pb">Nova senha (mín. 8)</label><input id="pb" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={8} autoComplete="new-password" />
        <button className="btn mt">Alterar senha</button>
      </form>
      <button className="btn sec block" onClick={() => void logout().then(() => nav('/'))}>Sair</button>
    </>
  );
}

export default function Conta() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return user ? <Profile /> : <AuthForms />;
}
