/** Fuso oficial do app: São Luís–MA (UTC−3, sem horário de verão). */
export const TZ = 'America/Fortaleza';

const dtf = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** "dd/mm/aaaa hh:mm:ss" no fuso de São Luís. */
export function formatDateTime(d: Date | string): string {
  return dtf.format(typeof d === 'string' ? new Date(d) : d).replace(',', '');
}

/** Data local (AAAA-MM-DD) em São Luís. */
export function localDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // en-CA => AAAA-MM-DD
}

export function isLocalDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
