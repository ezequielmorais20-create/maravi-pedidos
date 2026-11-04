export type CsvCell = string | number | null | undefined;

/** Neutraliza injeção de fórmulas em planilhas (=, +, -, @, TAB, CR no início de texto). */
function guard(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cell(v: CsvCell, trusted: boolean): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!trusted) s = guard(s);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvColumn<T> {
  header: string;
  /** Valores numéricos/monetários gerados pelo sistema (não vindos de usuário) dispensam a proteção de fórmula. */
  value: (row: T) => CsvCell;
  trusted?: boolean;
}

/** CSV com separador ";" e BOM UTF-8 (abre corretamente no Excel pt-BR). */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header, true)).join(';');
  const body = rows.map((r) => columns.map((c) => cell(c.value(r), c.trusted ?? false)).join(';'));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
