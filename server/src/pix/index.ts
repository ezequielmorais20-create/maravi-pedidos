import { config } from '../config';
import { unavailable } from '../lib/errors';
import type { PixProvider } from './provider';
import { SimulatedPixProvider } from './simulated';

let simulated: SimulatedPixProvider | null = null;

export function isPixSimulated(): boolean {
  return config.pix.mode === 'simulado' && !config.isProd;
}

/**
 * Seleciona o adaptador conforme PIX_MODE.
 *  - desabilitado: nenhuma cobrança é criada (padrão seguro).
 *  - simulado: provedor falso, só em desenvolvimento/homologação.
 *  - real: NÃO IMPLEMENTADO. Cobranças reais ficam desabilitadas até a integração oficial ser
 *          escrita e homologada (docs/HOMOLOGACAO.md). Implemente PixProvider e retorne-o aqui.
 */
export function getPixProvider(): PixProvider {
  switch (config.pix.mode) {
    case 'simulado':
      if (config.isProd) throw unavailable('Pix simulado não pode ser usado em produção.', 'pix_desabilitado');
      simulated ??= new SimulatedPixProvider(config.pix.webhookSecret, {
        key: config.pix.receiverKey,
        name: config.pix.receiverName,
        city: config.pix.receiverCity,
      });
      return simulated;
    case 'real':
      throw unavailable('A integração Pix real ainda não foi homologada. Cobranças reais estão desabilitadas.', 'pix_nao_homologado');
    default:
      throw unavailable('O pagamento por Pix está indisponível no momento.', 'pix_desabilitado');
  }
}

/** Provedor simulado tipado (somente quando o modo é simulado). */
export function getSimulatedProvider(): SimulatedPixProvider {
  const p = getPixProvider();
  if (!(p instanceof SimulatedPixProvider)) throw unavailable('Simulação indisponível.', 'pix_desabilitado');
  return p;
}

export function pixPublicStatus() {
  return {
    mode: config.pix.mode,
    enabled: config.pix.mode === 'simulado' && !config.isProd,
    simulated: isPixSimulated(),
    realIntegrationReady: false,
    realCredentialsPresent: config.pix.realConfigured,
  };
}
