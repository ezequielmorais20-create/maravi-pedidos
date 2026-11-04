import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv } from '../../src/lib/csv';
import { centsToPlain, formatBRL, parseBRLToCents, percentOfFloor } from '../../src/lib/money';
import { localDate } from '../../src/lib/time';

test('dinheiro: sempre em centavos inteiros', () => {
  assert.equal(parseBRLToCents('15,00'), 1500);
  assert.equal(parseBRLToCents('R$ 1.234,56'), 123456);
  assert.equal(parseBRLToCents('10.5'), 1050);
  assert.equal(parseBRLToCents('abc'), null);
  assert.equal(parseBRLToCents('1,234'), null);
  assert.equal(centsToPlain(-1505), '-15,05');
  assert.equal(centsToPlain(7), '0,07');
  assert.match(formatBRL(1500).replace(/\s/g, ' '), /R\$\s?15,00/);
});

test('desconto percentual arredonda para baixo (sem frações de centavo)', () => {
  assert.equal(percentOfFloor(1999, 5), 99);
  assert.equal(percentOfFloor(3000, 0), 0);
  assert.equal(percentOfFloor(3000, 10), 300);
});

test('datas: dia local de São Luís (UTC−3), não o dia UTC', () => {
  // 01:30 UTC de 05/11 ainda é 22:30 de 04/11 em São Luís
  assert.equal(localDate(new Date('2026-11-05T01:30:00Z')), '2026-11-04');
  assert.equal(localDate(new Date('2026-11-05T03:00:00Z')), '2026-11-05');
});

test('CSV: ; como separador, BOM, aspas e proteção contra fórmulas', () => {
  const csv = toCsv(
    [{ nome: '=HYPERLINK("http://x")', obs: 'a;b', valor: -1500 }, { nome: 'Maria', obs: 'ok', valor: 1500 }],
    [
      { header: 'Nome', value: (r) => r.nome },
      { header: 'Obs', value: (r) => r.obs },
      { header: 'Valor', value: (r) => centsToPlain(r.valor), trusted: true },
    ],
  );
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '﻿Nome;Obs;Valor');
  assert.ok(lines[1]!.startsWith(`"'=HYPERLINK(""http://x"")";"a;b";-15,00`), lines[1]);
  assert.equal(lines[2], 'Maria;ok;15,00');
});
