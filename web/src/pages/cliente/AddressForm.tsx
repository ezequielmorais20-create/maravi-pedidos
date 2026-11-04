import { useState } from 'react';
import { Alert } from '../../components/ui';
import { post, put } from '../../lib/api';
import { errMsg } from '../../lib/hooks';

export default function AddressForm({ initial, onSaved }: { initial?: any; onSaved: (a: any) => void }) {
  const [f, setF] = useState<any>({ label: 'Casa', recipient: '', phone: '', cep: '', street: '', number: '', complement: '', neighborhood: '', reference: '', isDefault: false, ...(initial ?? {}) });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const body = { label: f.label, recipient: f.recipient, phone: f.phone || null, cep: f.cep || null, street: f.street, number: f.number, complement: f.complement || null, neighborhood: f.neighborhood, reference: f.reference || null, isDefault: !!f.isDefault };
    try { onSaved(initial?.id ? await put(`/api/me/addresses/${initial.id}`, body) : await post('/api/me/addresses', body)); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  const F = ({ k, l, ...r }: any) => (<><label htmlFor={`a-${k}`}>{l}</label><input id={`a-${k}`} value={f[k] ?? ''} onChange={set(k)} {...r} /></>);
  return (
    <form onSubmit={submit} className="card">
      {err && <Alert>{err}</Alert>}
      <F k="label" l="Nome do endereço (Casa, Trabalho…)" required maxLength={40} />
      <F k="recipient" l="Quem recebe" required />
      <F k="phone" l="Telefone" inputMode="tel" />
      <F k="cep" l="CEP" inputMode="numeric" />
      <F k="street" l="Rua / Avenida" required />
      <F k="number" l="Número" required />
      <F k="complement" l="Complemento" />
      <F k="neighborhood" l="Bairro" required />
      <F k="reference" l="Ponto de referência" />
      <label><input type="checkbox" checked={!!f.isDefault} onChange={set('isDefault')} /> Usar como endereço padrão</label>
      <button className="btn block mt" disabled={busy}>{busy ? 'Salvando…' : 'Salvar endereço'}</button>
    </form>
  );
}
