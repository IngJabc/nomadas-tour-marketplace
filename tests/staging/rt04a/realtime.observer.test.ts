/**
 * RT-04A · Staging · Observador de transiciones (requiere operador).
 *
 * El harness NO muta ningún estado: solo se suscribe y espera. Un operador
 * autorizado ejecuta la transición real (verificar pago / actualizar viaje)
 * durante la ventana. El harness valida la entrega de eventos.
 *
 * Requiere `STAGING_OBSERVE=1` además de `STAGING_ALLOW=1`.
 * Ventana: `STAGING_OBSERVE_WINDOW_MS` (default 60000).
 *
 * Escenarios: 3 (A recibe el cambio de su compra sin recargar),
 * 4 (B no recibe eventos de A), 7 (catálogo `trips` se entrega sin recarga).
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  describeConfigPresence,
  loadStagingConfig,
  redact,
  stagingEnabled,
  type StagingConfig,
} from './support/env';
import {
  closeChannel,
  createCustomerClient,
  decodeJwtSub,
  openCaptureChannel,
  subscribeChannel,
  waitWindow,
  type CapturedEvent,
} from './support/realtime';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const enabled = stagingEnabled();
const observe = enabled && process.env.STAGING_OBSERVE === '1';

function logOperator(text: string, secrets: string[]): void {
  console.log(`[operador] ${redact(text, secrets)}`);
}

describe.skipIf(!observe)('RT-04A staging · observador de transiciones (no muta)', () => {
  let cfg: StagingConfig;
  let customerAId: string;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let secrets: string[];

  beforeAll(async () => {
    cfg = loadStagingConfig();
    console.log(`[staging] config:\n${describeConfigPresence(cfg)}`);
    customerAId = decodeJwtSub(cfg.customerAToken);
    clientA = createCustomerClient(cfg, cfg.customerAToken);
    clientB = createCustomerClient(cfg, cfg.customerBToken);
    secrets = [cfg.customerAToken, cfg.customerBToken, cfg.supabaseAnonKey];
  });

  afterAll(async () => {
    if (clientA) await clientA.removeAllChannels();
    if (clientB) await clientB.removeAllChannels();
  });

  it('3+4) A recibe el cambio de su compra; B no recibe nada', async (ctx) => {
    const attemptId = cfg.attemptIdA;
    if (!attemptId) {
      ctx.skip('falta STAGING_ATTEMPT_ID_A');
      return;
    }
    const sinkA: CapturedEvent[] = [];
    const sinkB: CapturedEvent[] = [];
    const channelA: RealtimeChannel = openCaptureChannel(
      clientA,
      cfg.customerAToken,
      'obs:A',
      [{ table: 'checkout_attempts', filter: `customer_id=eq.${customerAId}` }],
      sinkA,
    );
    const channelB: RealtimeChannel = openCaptureChannel(
      clientB,
      cfg.customerBToken,
      'obs:B',
      [{ table: 'checkout_attempts', filter: `customer_id=eq.${customerAId}` }],
      sinkB,
    );
    expect(await subscribeChannel(channelA)).toBe('SUBSCRIBED');
    expect(await subscribeChannel(channelB)).toBe('SUBSCRIBED');

    logOperator(
      `Ventana abierta (${cfg.observeWindowMs}ms). Ejecuta UNA transición real sobre el intento ${attemptId} (verificar pago / actualizar estado) y observa la entrega.`,
      secrets,
    );
    await waitWindow(cfg.observeWindowMs);

    await closeChannel(clientA, channelA);
    await closeChannel(clientB, channelB);

    expect(sinkA.length, 'A debe recibir al menos un evento de su compra').toBeGreaterThan(0);
    expect(sinkB.length, 'B no debe recibir eventos de la compra de A').toBe(0);
  });

  it('7) catálogo trips se entrega sin recarga', async () => {
    const sinkTrips: CapturedEvent[] = [];
    const channel: RealtimeChannel = openCaptureChannel(
      clientA,
      cfg.customerAToken,
      'obs:trips',
      [{ table: 'trips' }],
      sinkTrips,
    );
    expect(await subscribeChannel(channel)).toBe('SUBSCRIBED');

    logOperator(
      `Ventana abierta (${cfg.observeWindowMs}ms). Ejecuta UNA transición sobre un viaje del catálogo (p. ej. publicar/unpublish) para observar el evento.`,
      secrets,
    );
    await waitWindow(cfg.observeWindowMs);

    await closeChannel(clientA, channel);
    expect(sinkTrips.length, 'debe llegar al menos un evento de trips').toBeGreaterThan(0);
  });
});
