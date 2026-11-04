/** Máquina de estados do atendimento (independente do status financeiro). */
export type FulfillmentStatus =
  | 'aguardando_pagamento'
  | 'pago'
  | 'em_separacao'
  | 'pronto_retirada'
  | 'saiu_entrega'
  | 'concluido'
  | 'em_analise'
  | 'cancelado';

export const NEXT: Record<string, string[]> = {
  pago: ['em_separacao'],
  em_separacao: ['pronto_retirada', 'saiu_entrega'],
  pronto_retirada: ['concluido'],
  saiu_entrega: ['concluido'],
};

/** Etapas que tiram o pedido da loja: ficam bloqueadas enquanto houver exceção de estoque aberta. */
export const DISPATCH = new Set(['pronto_retirada', 'saiu_entrega', 'concluido']);

export type Transition = { ok: true } | { ok: false; code: 'transicao_invalida' | 'modalidade_invalida' | 'excecao_aberta'; message: string };

export function checkTransition(from: string, to: string, deliveryMode: 'retirada' | 'entrega', openExceptions: number): Transition {
  if (!(NEXT[from] ?? []).includes(to)) return { ok: false, code: 'transicao_invalida', message: `Transição inválida: ${from} → ${to}.` };
  if (to === 'pronto_retirada' && deliveryMode !== 'retirada') return { ok: false, code: 'modalidade_invalida', message: 'Este pedido é para entrega.' };
  if (to === 'saiu_entrega' && deliveryMode !== 'entrega') return { ok: false, code: 'modalidade_invalida', message: 'Este pedido é para retirada.' };
  if (DISPATCH.has(to) && openExceptions > 0) {
    return { ok: false, code: 'excecao_aberta', message: 'Expedição bloqueada: há exceção de estoque (avaria) aberta neste pedido. Resolva a exceção ou estorne.' };
  }
  return { ok: true };
}
