/** Geração do "Pix Copia e Cola" (BR Code estático/dinâmico simplificado, EMV® QRCPS-MPM). Código puro, sem dependências. */

const tlv = (id: string, value: string): string => id + String(value.length).padStart(2, '0') + value;

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF). Vetor de teste: "123456789" → "29B1". */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function asciiUpper(s: string, max: number): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
    .slice(0, max);
}

export interface BrCodeInput {
  key: string; // chave Pix do recebedor
  name: string; // nome do recebedor (máx. 25)
  city: string; // cidade (máx. 15)
  amountCents: number;
  txid: string; // identificador da transação (alfanumérico, máx. 25)
}

export function buildBrCode(i: BrCodeInput): string {
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new Error('Valor inválido para o BR Code.');
  const txid = i.txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const amount = `${Math.floor(i.amountCents / 100)}.${String(i.amountCents % 100).padStart(2, '0')}`;
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('01', i.key);
  const body =
    tlv('00', '01') + // versão do payload
    tlv('01', '12') + // ponto de iniciação: uso único
    tlv('26', account) +
    tlv('52', '0000') +
    tlv('53', '986') + // BRL
    tlv('54', amount) +
    tlv('58', 'BR') +
    tlv('59', asciiUpper(i.name, 25) || 'MARAVI') +
    tlv('60', asciiUpper(i.city, 15) || 'SAO LUIS') +
    tlv('62', tlv('05', txid)) +
    '6304';
  return body + crc16(body);
}

/** Valida o CRC de um BR Code (útil em testes e na conferência de homologação). */
export function isValidBrCode(code: string): boolean {
  if (code.length < 8 || code.slice(-8, -4) !== '6304') return false;
  return crc16(code.slice(0, -4)) === code.slice(-4);
}
