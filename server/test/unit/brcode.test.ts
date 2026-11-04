import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrCode, crc16, isValidBrCode } from '../../src/pix/brcode';

test('CRC16/CCITT-FALSE: vetor de referência "123456789" = 29B1', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('BR Code: campos obrigatórios, valor em reais e CRC válido', () => {
  const code = buildBrCode({ key: 'simulacao@maravi.invalid', name: 'Simulação MARAVI', city: 'São Luís', amountCents: 1500, txid: 'SIM123ABC' });
  assert.ok(code.startsWith('000201'), 'versão do payload');
  assert.ok(code.includes('br.gov.bcb.pix'), 'GUI do Pix');
  assert.ok(code.includes('540515.00'), 'valor 15.00 com tamanho 05');
  assert.ok(code.includes('5303986'), 'moeda BRL');
  assert.ok(code.includes('5802BR'), 'país');
  assert.ok(code.includes('SIMULACAO MARAVI'), 'nome sem acentos, em maiúsculas');
  assert.ok(code.includes('SAO LUIS'), 'cidade sem acentos');
  assert.ok(isValidBrCode(code));
});

test('BR Code: alteração de qualquer caractere invalida o CRC', () => {
  const code = buildBrCode({ key: 'k@x.y', name: 'MARAVI', city: 'SAO LUIS', amountCents: 1000, txid: 'ABC' });
  assert.ok(isValidBrCode(code));
  const tampered = code.replace('10.00', '99.00');
  assert.notEqual(tampered, code);
  assert.equal(isValidBrCode(tampered), false);
});

test('BR Code: valores com centavos e rejeição de valor inválido', () => {
  assert.ok(buildBrCode({ key: 'k', name: 'M', city: 'C', amountCents: 5, txid: 'A' }).includes('54040.05'));
  assert.ok(buildBrCode({ key: 'k', name: 'M', city: 'C', amountCents: 123456, txid: 'A' }).includes('54071234.56'));
  assert.throws(() => buildBrCode({ key: 'k', name: 'M', city: 'C', amountCents: 0, txid: 'A' }));
  assert.throws(() => buildBrCode({ key: 'k', name: 'M', city: 'C', amountCents: 10.5, txid: 'A' }));
});
