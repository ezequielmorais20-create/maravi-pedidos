const TZ = 'America/Fortaleza';
export const brl = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const dt = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const hm = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';
export const todayLocal = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // AAAA-MM-DD
export const reaisToCents = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
export const centsToReais = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export const PAYMENT_LABEL: Record<string, string> = {
  pendente: 'Aguardando Pix', pago: 'Pago', expirado: 'Pix expirado', cancelado: 'Cancelado', estornado: 'Estornado',
};
export const FULFILLMENT_LABEL: Record<string, string> = {
  aguardando_pagamento: 'Aguardando pagamento', pago: 'Pago — na fila', em_analise: 'Em análise', em_separacao: 'Em separação',
  pronto_retirada: 'Pronto para retirada', saiu_entrega: 'Saiu para entrega', concluido: 'Concluído', cancelado: 'Cancelado',
};
export const ROLE_LABEL: Record<string, string> = { administrador: 'Administrador', atendimento: 'Atendimento', estoque: 'Estoque', cliente: 'Cliente' };
