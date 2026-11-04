import { normalize } from './text';

export interface Zone {
  id: number;
  name: string;
  neighborhoods: string[];
  feeCents: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  active: boolean;
  sortOrder: number;
}

/** Encontra a zona atendida pelo bairro informado (sem acentos, maiúsculas ou espaços extras). */
export function matchZone<T extends Pick<Zone, 'neighborhoods' | 'active'>>(zones: T[], neighborhood: string): T | undefined {
  const n = normalize(neighborhood);
  if (!n) return undefined;
  return zones.find((z) => z.active && z.neighborhoods.some((b) => normalize(b) === n));
}

export function etaText(z: Pick<Zone, 'etaMinMinutes' | 'etaMaxMinutes'>): string {
  return z.etaMinMinutes === z.etaMaxMinutes
    ? `Entrega em cerca de ${z.etaMinMinutes} min após a confirmação do Pix.`
    : `Entrega em ${z.etaMinMinutes} a ${z.etaMaxMinutes} min após a confirmação do Pix.`;
}
