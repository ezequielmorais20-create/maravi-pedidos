import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTransition } from '../../src/lib/fulfillment';
import { escapeLike, normalize } from '../../src/lib/text';
import { etaText, matchZone } from '../../src/lib/zones';

const zones = [
  { neighborhoods: ['São Raimundo', 'Anjo da Guarda'], active: true, feeCents: 500 },
  { neighborhoods: ['Centro'], active: true, feeCents: 800 },
  { neighborhoods: ['Cohab'], active: false, feeCents: 900 },
];

test('zonas: bairro casa sem acento, caixa ou espaço extra; inativa e desconhecida não atendem', () => {
  assert.equal(matchZone(zones, 'sao raimundo')?.feeCents, 500);
  assert.equal(matchZone(zones, '  SÃO   RAIMUNDO ')?.feeCents, 500);
  assert.equal(matchZone(zones, 'centro')?.feeCents, 800);
  assert.equal(matchZone(zones, 'Cohab'), undefined, 'zona desativada');
  assert.equal(matchZone(zones, 'Bairro Inexistente'), undefined);
  assert.equal(matchZone(zones, ''), undefined);
});

test('prazo: texto com faixa ou valor único', () => {
  assert.match(etaText({ etaMinMinutes: 30, etaMaxMinutes: 60 }), /30 a 60 min/);
  assert.match(etaText({ etaMinMinutes: 45, etaMaxMinutes: 45 }), /cerca de 45 min/);
});

test('atendimento: fluxo válido de retirada e de entrega', () => {
  assert.deepEqual(checkTransition('pago', 'em_separacao', 'retirada', 0), { ok: true });
  assert.deepEqual(checkTransition('em_separacao', 'pronto_retirada', 'retirada', 0), { ok: true });
  assert.deepEqual(checkTransition('pronto_retirada', 'concluido', 'retirada', 0), { ok: true });
  assert.deepEqual(checkTransition('em_separacao', 'saiu_entrega', 'entrega', 0), { ok: true });
  assert.deepEqual(checkTransition('saiu_entrega', 'concluido', 'entrega', 0), { ok: true });
});

test('atendimento: não pula etapas, não volta e respeita a modalidade', () => {
  assert.equal(checkTransition('pago', 'concluido', 'retirada', 0).ok, false);
  assert.equal(checkTransition('concluido', 'em_separacao', 'retirada', 0).ok, false);
  assert.equal(checkTransition('aguardando_pagamento', 'em_separacao', 'retirada', 0).ok, false);
  const r1 = checkTransition('em_separacao', 'saiu_entrega', 'retirada', 0);
  assert.ok(!r1.ok && r1.code === 'modalidade_invalida');
  const r2 = checkTransition('em_separacao', 'pronto_retirada', 'entrega', 0);
  assert.ok(!r2.ok && r2.code === 'modalidade_invalida');
});

test('exceção de estoque aberta bloqueia a expedição, mas não a separação', () => {
  assert.equal(checkTransition('pago', 'em_separacao', 'retirada', 1).ok, true);
  const r = checkTransition('em_separacao', 'pronto_retirada', 'retirada', 1);
  assert.ok(!r.ok && r.code === 'excecao_aberta');
  const r2 = checkTransition('em_separacao', 'saiu_entrega', 'entrega', 2);
  assert.ok(!r2.ok && r2.code === 'excecao_aberta');
});

test('texto: normalização e escape de curingas do LIKE', () => {
  assert.equal(normalize('  ÓCULOS   de Sol '), 'oculos de sol');
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});
