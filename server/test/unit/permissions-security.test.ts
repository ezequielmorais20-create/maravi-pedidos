import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERMISSIONS, can, permissionsOf } from '../../src/lib/permissions';
import { hashPassword, hmacSha256Hex, safeEqualHex, sha256Hex, validatePasswordStrength, verifyPassword } from '../../src/lib/security';

test('permissões: administrador tem tudo; cliente não tem nenhuma permissão de equipe', () => {
  for (const p of PERMISSIONS) {
    assert.equal(can('administrador', p), true, p);
    assert.equal(can('cliente', p), false, p);
  }
  assert.equal(permissionsOf('cliente').length, 0);
});

test('permissões: atendimento enxerga pedidos e dados pessoais, mas não caixa, custo nem estoque operacional', () => {
  assert.ok(can('atendimento', 'orders.view') && can('atendimento', 'customers.pii') && can('atendimento', 'orders.totals'));
  for (const p of ['cash.view', 'cash.manage', 'orders.refund', 'products.cost', 'products.price', 'stock.damage', 'stock.move', 'settings.edit', 'staff.manage', 'audit.view'] as const) {
    assert.equal(can('atendimento', p), false, p);
  }
});

test('permissões: estoque opera estoque/avarias, mas não vê dados pessoais, valores, caixa nem custo', () => {
  assert.ok(can('estoque', 'stock.move') && can('estoque', 'stock.damage') && can('estoque', 'stock.resolve'));
  for (const p of ['customers.pii', 'orders.totals', 'cash.view', 'products.cost', 'products.price', 'orders.refund'] as const) {
    assert.equal(can('estoque', p), false, p);
  }
});

test('permissões: papel desconhecido ou ausente nunca autoriza', () => {
  assert.equal(can('root', 'orders.view'), false);
  assert.equal(can(undefined, 'orders.view'), false);
  assert.equal(can(null, 'orders.view'), false);
});

test('senha: hash scrypt verifica a correta e rejeita a errada; hashes diferem por sal', async () => {
  const h1 = await hashPassword('Senha@123abc', 10);
  const h2 = await hashPassword('Senha@123abc', 10);
  assert.notEqual(h1, h2);
  assert.ok(h1.startsWith('scrypt$1024$8$1$'));
  assert.equal(await verifyPassword('Senha@123abc', h1), true);
  assert.equal(await verifyPassword('senha@123abc', h1), false);
  assert.equal(await verifyPassword('x', 'formato-invalido'), false);
});

test('senha: política mínima', () => {
  assert.ok(validatePasswordStrength('curta1'));
  assert.ok(validatePasswordStrength('somenteletras'));
  assert.ok(validatePasswordStrength('12345678'));
  assert.equal(validatePasswordStrength('Maravi2026'), null);
});

test('HMAC do webhook: assinatura correta passa; corpo alterado ou segredo errado falha', () => {
  const secret = 's'.repeat(40);
  const body = Buffer.from('{"id":"e1","type":"pix.paid"}');
  const sig = hmacSha256Hex(secret, body);
  assert.equal(safeEqualHex(sig, hmacSha256Hex(secret, body)), true);
  assert.equal(safeEqualHex(sig, hmacSha256Hex(secret, Buffer.from('{"id":"e1","type":"pix.paid" }'))), false);
  assert.equal(safeEqualHex(sig, hmacSha256Hex('outro-segredo'.padEnd(40, 'x'), body)), false);
  assert.equal(safeEqualHex(sig, 'curto'), false);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
