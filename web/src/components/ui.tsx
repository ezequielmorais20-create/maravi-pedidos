import type { ReactNode } from 'react';
import { FULFILLMENT_LABEL, PAYMENT_LABEL } from '../lib/format';

export const Alert = ({ kind = 'err', children }: { kind?: 'err' | 'ok' | 'warn' | 'info'; children: ReactNode }) => <div className={`alert ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>{children}</div>;
export const Loading = () => <p className="muted">Carregando…</p>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="card center muted">{children}</div>;

export function PayTag({ s }: { s: string }) {
  const k = s === 'pago' ? 'ok' : s === 'pendente' ? 'warn' : s === 'estornado' || s === 'expirado' || s === 'cancelado' ? 'err' : '';
  return <span className={`tag ${k}`}>{PAYMENT_LABEL[s] ?? s}</span>;
}
export function FulTag({ s }: { s: string }) {
  const k = s === 'concluido' ? 'ok' : s === 'em_analise' ? 'warn' : s === 'cancelado' ? 'err' : '';
  return <span className={`tag ${k}`}>{FULFILLMENT_LABEL[s] ?? s}</span>;
}
export function Img({ src, alt }: { src?: string | null; alt: string }) {
  return src ? <img src={src} alt={alt} loading="lazy" /> : <img alt={alt} src="/icons/icon-192.png" style={{ objectFit: 'contain', padding: 8 }} />;
}
