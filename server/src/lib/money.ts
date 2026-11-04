/** Todo valor monetário é inteiro em centavos. */
const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return fmt.format(cents / 100);
}

/** "15,00" / "15.5" / "1.234,56" → 1500 / 1550 / 123456. Retorna null se inválido. */
export function parseBRLToCents(input: string): number | null {
  let s = input.trim().replace(/^R\$\s*/, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
}

/** Percentual inteiro/decimal sobre centavos, arredondando para baixo (favorece a cliente em descontos). */
export function percentOfFloor(cents: number, percent: number): number {
  return Math.floor((cents * percent) / 100);
}

/** Centavos → "15,00" (sem símbolo; usado em CSV). */
export function centsToPlain(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
