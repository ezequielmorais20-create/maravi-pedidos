import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, q, q1 } from '../db';
import { conflict, notFound, badRequest } from '../lib/errors';
import { hmacSha256Hex, safeEqualHex } from '../lib/security';
import { buildBrCode } from './brcode';
import type {
  CreateChargeInput,
  CreatedCharge,
  HeaderBag,
  PixEvent,
  PixProvider,
  ProviderCharge,
  ProviderChargeStatus,
  ProviderSettlement,
} from './provider';

export const SIGNATURE_HEADER = 'x-maravi-signature';

const eventSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(100),
    type: z.literal('pix.paid'),
    charge_id: z.string().min(1).max(100),
    amount_cents: z.number().int().positive(),
    status: z.enum(['ATIVA', 'CONCLUIDA', 'EXPIRADA', 'CANCELADA']),
    settled_at: z.string().datetime({ offset: true }),
    fee_cents: z.number().int().min(0).default(0),
  }),
  z.object({
    id: z.string().min(1).max(100),
    type: z.literal('pix.refunded'),
    charge_id: z.string().min(1).max(100),
    refund_id: z.string().min(1).max(100),
    amount_cents: z.number().int().positive(),
    settled_at: z.string().datetime({ offset: true }),
  }),
]);

export interface SignedEvent {
  body: Buffer;
  headers: Record<string, string>;
}

/**
 * Provedor Pix FALSO. Não movimenta dinheiro, não fala com nenhum banco.
 * O "lado do banco" fica na tabela pix_simulator_charges. Os eventos que ele emite têm o mesmo
 * formato e passam pela MESMA verificação de assinatura e pelo MESMO processador dos eventos reais.
 */
export class SimulatedPixProvider implements PixProvider {
  readonly name = 'simulado';
  readonly simulated = true;

  constructor(
    private readonly secret: string,
    private readonly receiver: { key: string; name: string; city: string },
  ) {}

  async createCharge(i: CreateChargeInput): Promise<CreatedCharge> {
    const providerChargeId = `SIM${randomBytes(10).toString('hex').toUpperCase()}`;
    await pool.query(`INSERT INTO pix_simulator_charges (provider_charge_id, amount_cents, expires_at) VALUES ($1,$2,$3)`, [
      providerChargeId,
      i.amountCents,
      i.expiresAt,
    ]);
    const brcode = buildBrCode({
      key: this.receiver.key || 'simulacao@maravi.invalid', // chave inexistente de propósito
      name: `SIMULACAO ${this.receiver.name}`,
      city: this.receiver.city,
      amountCents: i.amountCents,
      txid: providerChargeId,
    });
    return { providerChargeId, brcode };
  }

  async getCharge(providerChargeId: string): Promise<ProviderCharge> {
    const r = await q1<{ status: ProviderChargeStatus; amountCents: number; settledAt: Date | null; feeCents: number }>(
      pool,
      `SELECT status, amount_cents, settled_at, fee_cents FROM pix_simulator_charges WHERE provider_charge_id = $1`,
      [providerChargeId],
    );
    if (!r) throw notFound('Cobrança inexistente no provedor simulado.');
    return { providerChargeId, status: r.status, amountCents: r.amountCents, settledAt: r.settledAt, feeCents: r.feeCents };
  }

  async cancelCharge(providerChargeId: string): Promise<void> {
    await pool.query(`UPDATE pix_simulator_charges SET status = 'CANCELADA' WHERE provider_charge_id = $1 AND status = 'ATIVA'`, [
      providerChargeId,
    ]);
  }

  async refund(i: { providerChargeId: string; amountCents: number; refundRef: string }): Promise<{ providerRefundId: string }> {
    const c = await this.getCharge(i.providerChargeId);
    if (c.status !== 'CONCLUIDA') throw conflict('Só é possível estornar cobrança já paga.', 'estorno_invalido');
    const upd = await pool.query(
      `UPDATE pix_simulator_charges SET refunded_cents = refunded_cents + $2
        WHERE provider_charge_id = $1 AND refunded_cents + $2 <= amount_cents`,
      [i.providerChargeId, i.amountCents],
    );
    if (upd.rowCount === 0) throw conflict('Valor de estorno acima do valor pago.', 'estorno_invalido');
    return { providerRefundId: `SIMR${randomBytes(8).toString('hex').toUpperCase()}` };
  }

  async listSettlements(from: Date, to: Date): Promise<ProviderSettlement[]> {
    return q<ProviderSettlement>(
      pool,
      `SELECT provider_charge_id, amount_cents, settled_at, fee_cents
         FROM pix_simulator_charges
        WHERE status = 'CONCLUIDA' AND settled_at >= $1 AND settled_at < $2
        ORDER BY settled_at, provider_charge_id`,
      [from, to],
    );
  }

  // ---------------------------------------------------------------- webhooks
  verifyWebhook(rawBody: Buffer, headers: HeaderBag): boolean {
    const h = headers[SIGNATURE_HEADER];
    const got = (Array.isArray(h) ? h[0] : h)?.replace(/^sha256=/, '');
    if (!got) return false;
    return safeEqualHex(got, hmacSha256Hex(this.secret, rawBody));
  }

  parseWebhook(rawBody: Buffer): PixEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw badRequest('Corpo do evento não é JSON.', undefined, 'evento_invalido');
    }
    const r = eventSchema.safeParse(json);
    if (!r.success) throw badRequest('Evento Pix inválido.', r.error.issues, 'evento_invalido');
    const e = r.data;
    if (e.type === 'pix.paid') {
      return {
        type: 'pix.paid',
        eventId: e.id,
        providerChargeId: e.charge_id,
        amountCents: e.amount_cents,
        status: e.status,
        settledAt: new Date(e.settled_at),
        feeCents: e.fee_cents,
        raw: json,
      };
    }
    return {
      type: 'pix.refunded',
      eventId: e.id,
      providerChargeId: e.charge_id,
      providerRefundId: e.refund_id,
      amountCents: e.amount_cents,
      settledAt: new Date(e.settled_at),
      raw: json,
    };
  }

  // ------------------------------------------------- exclusivos do simulador
  /** Assina um payload exatamente como o provedor faria. */
  sign(payload: Record<string, unknown>): SignedEvent {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    return { body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: hmacSha256Hex(this.secret, body) } };
  }

  /**
   * "A cliente pagou no app do banco": marca a cobrança como CONCLUIDA no lado do provedor
   * e devolve o evento assinado (ainda NÃO entregue ao app — quem chama decide quando entregar).
   */
  async markPaid(
    providerChargeId: string,
    opts: { settledAt?: Date; feeCents?: number; amountCents?: number; eventId?: string } = {},
  ): Promise<SignedEvent> {
    const cur = await this.getCharge(providerChargeId);
    const settledAt = cur.status === 'CONCLUIDA' && cur.settledAt ? cur.settledAt : (opts.settledAt ?? new Date());
    if (cur.status !== 'CONCLUIDA') {
      await pool.query(
        `UPDATE pix_simulator_charges SET status = 'CONCLUIDA', settled_at = $2, fee_cents = $3 WHERE provider_charge_id = $1`,
        [providerChargeId, settledAt, opts.feeCents ?? 0],
      );
    }
    return this.sign({
      id: opts.eventId ?? `evt_${randomBytes(8).toString('hex')}`,
      type: 'pix.paid',
      charge_id: providerChargeId,
      amount_cents: opts.amountCents ?? cur.amountCents,
      status: 'CONCLUIDA',
      settled_at: settledAt.toISOString(),
      fee_cents: opts.feeCents ?? cur.feeCents,
    });
  }

  refundEvent(i: { providerChargeId: string; providerRefundId: string; amountCents: number; eventId?: string; settledAt?: Date }): SignedEvent {
    return this.sign({
      id: i.eventId ?? `evt_${randomBytes(8).toString('hex')}`,
      type: 'pix.refunded',
      charge_id: i.providerChargeId,
      refund_id: i.providerRefundId,
      amount_cents: i.amountCents,
      settled_at: (i.settledAt ?? new Date()).toISOString(),
    });
  }
}
