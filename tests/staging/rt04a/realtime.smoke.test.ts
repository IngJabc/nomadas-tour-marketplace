/**
 * RT-04A · Staging · Smoke de conectividad Realtime.
 *
 * Verifica ÚNICAMENTE que A y B pueden abrir un canal `postgres_changes`
 * autenticado. NO es evidencia de RLS ni de entrega aislada de eventos —
 * eso se prueba en realtime.observer.test.ts (modo observador) y en el
 * aislamiento de API.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  describeConfigPresence,
  loadStagingConfig,
  stagingEnabled,
  type StagingConfig,
} from './support/env';
import {
  closeChannel,
  createCustomerClient,
  decodeJwtSub,
  openCaptureChannel,
  subscribeChannel,
  type CapturedEvent,
} from './support/realtime';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const enabled = stagingEnabled();

describe.skipIf(!enabled)('RT-04A staging · smoke Realtime (conectividad, no RLS)', () => {
  let cfg: StagingConfig;
  let customerAId: string;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let channelA: RealtimeChannel;
  let channelB: RealtimeChannel;
  let sinkA: CapturedEvent[] = [];
  let sinkB: CapturedEvent[] = [];

  beforeAll(async () => {
    cfg = loadStagingConfig();
    console.log(`[staging] config:\n${describeConfigPresence(cfg)}`);
    customerAId = decodeJwtSub(cfg.customerAToken);
    clientA = createCustomerClient(cfg, cfg.customerAToken);
    clientB = createCustomerClient(cfg, cfg.customerBToken);
  });

  afterAll(async () => {
    if (channelA) await closeChannel(clientA, channelA);
    if (channelB) await closeChannel(clientB, channelB);
  });

  it('A y B abren un canal postgres_changes autenticado', async () => {
    channelA = openCaptureChannel(
      clientA,
      cfg.customerAToken,
      'smoke:A',
      [{ table: 'checkout_attempts', filter: `customer_id=eq.${customerAId}` }],
      sinkA,
    );
    channelB = openCaptureChannel(
      clientB,
      cfg.customerBToken,
      'smoke:B',
      [{ table: 'checkout_attempts', filter: `customer_id=eq.${customerAId}` }],
      sinkB,
    );
    const statusA = await subscribeChannel(channelA);
    const statusB = await subscribeChannel(channelB);
    expect(statusA).toBe('SUBSCRIBED');
    expect(statusB).toBe('SUBSCRIBED');
  });
});
