/** Contrato do adaptador de provedor Pix. Qualquer integração real precisa implementar esta interface. */

export type ProviderChargeStatus = 'ATIVA' | 'CONCLUIDA' | 'EXPIRADA' | 'CANCELADA';

export interface CreateChargeInput {
  /** Referência interna (id do pedido sem hífens) — vira o txid. */
  reference: string;
  amountCents: number;
  expiresAt: Date;
  description: string;
}
export interface CreatedCharge {
  providerChargeId: string;
  brcode: string; // Pix Copia e Cola
}
export interface ProviderCharge {
  providerChargeId: string;
  status: ProviderChargeStatus;
  amountCents: number;
  settledAt: Date | null; // horário efetivo da liquidação informado pelo provedor
  feeCents: number;
}
export interface ProviderSettlement {
  providerChargeId: string;
  amountCents: number;
  settledAt: Date;
  feeCents: number;
}

export type PixEvent =
  | {
      type: 'pix.paid';
      eventId: string;
      providerChargeId: string;
      amountCents: number;
      status: ProviderChargeStatus;
      settledAt: Date;
      feeCents: number;
      raw: unknown;
    }
  | {
      type: 'pix.refunded';
      eventId: string;
      providerChargeId: string;
      providerRefundId: string;
      amountCents: number;
      settledAt: Date;
      raw: unknown;
    };

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface PixProvider {
  readonly name: string;
  /** true somente para o provedor falso de desenvolvimento/homologação. */
  readonly simulated: boolean;
  createCharge(input: CreateChargeInput): Promise<CreatedCharge>;
  getCharge(providerChargeId: string): Promise<ProviderCharge>;
  cancelCharge(providerChargeId: string): Promise<void>;
  refund(input: { providerChargeId: string; amountCents: number; refundRef: string }): Promise<{ providerRefundId: string }>;
  listSettlements(from: Date, to: Date): Promise<ProviderSettlement[]>;
  /** Autenticidade do evento (assinatura HMAC / mTLS etc.). Deve ser em tempo constante. */
  verifyWebhook(rawBody: Buffer, headers: HeaderBag): boolean;
  parseWebhook(rawBody: Buffer): PixEvent;
}
