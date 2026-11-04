/** Normaliza para comparação: minúsculas, sem acentos, espaços colapsados. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function onlyDigits(s: string): string {
  return s.replace(/\D+/g, '');
}

/** Escapa curingas de LIKE/ILIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
