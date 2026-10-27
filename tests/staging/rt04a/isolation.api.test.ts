/**
 * RT-04A · Staging · Aislamiento de API (SOLO LECTURA).
 *
 * Escenarios automatizables sin transiciones de estado:
 *  - 1) A solo lista sus propias compras.
 *  - 2) B no puede consultar una compra de A (404 uniforme).
 *  - 5) Intento no elegible no expone QR (404 uniforme).
 *  - 6) Boleto elegible coincide con el backend (ticket_code, estado).
 *
 * Ejecución (requisitos): ver informe final de la tarea. Esta suite NO corre
 * en `npm test`, build ni CI. Requiere `STAGING_ALLOW=1` + variables explícitas.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  describeConfigPresence,
  loadStagingConfig,
  stagingEnabled,
  type StagingConfig,
} from './support/env';
import { getAttempt, getTicket, listPurchases } from './support/api';
import { decodeJwtSub } from './support/realtime';

const enabled = stagingEnabled();

describe.skipIf(!enabled)('RT-04A staging · aislamiento de API (solo lectura)', () => {
  let cfg: StagingConfig;
  let attemptAId: string | null;

  beforeAll(async () => {
    // Fallo seguro: lanza si falta alguna variable (lista solo nombres).
    cfg = loadStagingConfig();
    // Solo presencia/ausencia, nunca valores.
    console.log(`[staging] config:\n${describeConfigPresence(cfg)}`);
    const customerAId = decodeJwtSub(cfg.customerAToken);
    expect(customerAId, 'customer A token debe contener sub').toBeTruthy();
    const first = await listPurchases(cfg, cfg.customerAToken);
    expect(first.status, 'A debe poder listar sus compras').toBe(200);
    attemptAId = cfg.attemptIdA ?? first.data?.items?.[0]?.attempt_id ?? null;
  });

  it('1) A lista solo sus propias compras (200)', async () => {
    const res = await listPurchases(cfg, cfg.customerAToken);
    expect(res.status).toBe(200);
    for (const item of res.data?.items ?? []) {
      expect(typeof item.attempt_id).toBe('string');
      expect(item.attempt_id.length).toBeGreaterThan(0);
    }
  });

  it('2) B no consulta una compra de A (404 uniforme)', async (ctx) => {
    if (!attemptAId) {
      ctx.skip('no hay intento de A para probar acceso ajeno');
      return;
    }
    const ticket = await getTicket(cfg, cfg.customerBToken, attemptAId);
    expect(ticket.status).toBe(404);
    expect(ticket.errorCode).toBe('TICKET_NOT_FOUND');
    const attempt = await getAttempt(cfg, cfg.customerBToken, attemptAId);
    expect(attempt.status).toBe(404);
    expect(attempt.errorCode).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
    const listB = await listPurchases(cfg, cfg.customerBToken);
    expect(listB.status).toBe(200);
    const leaked = (listB.data?.items ?? []).some((i) => i.attempt_id === attemptAId);
    expect(leaked, 'B no debe ver el intento de A en su historial').toBe(false);
  });

  it('5) intento no elegible no expone QR (404 uniforme)', async (ctx) => {
    const ineligible = (await listPurchases(cfg, cfg.customerAToken)).data?.items?.find(
      (i) => i.estado !== 'reserva_confirmada' || !i.reserva?.ticket_code,
    );
    if (!ineligible) {
      ctx.skip('no hay intento no elegible en el historial de A');
      return;
    }
    const res = await getTicket(cfg, cfg.customerAToken, ineligible.attempt_id);
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('TICKET_NOT_FOUND');
  });

  it('6) boleto elegible coincide con el backend', async (ctx) => {
    const eligible = cfg.eligibleAttemptIdA;
    if (!eligible) {
      ctx.skip('falta STAGING_ELIGIBLE_ATTEMPT_ID_A');
      return;
    }
    const res = await getTicket(cfg, cfg.customerAToken, eligible);
    expect(res.status).toBe(200);
    expect(res.data?.estado).toBe('reserva_confirmada');
    expect(res.data?.ticket_code).toHaveLength(8);
    expect(res.data?.qr_code.length).toBeGreaterThan(0);
    const item = (await listPurchases(cfg, cfg.customerAToken)).data?.items?.find(
      (i) => i.attempt_id === eligible,
    );
    if (item?.reserva?.ticket_code) {
      expect(res.data?.ticket_code).toBe(item.reserva.ticket_code);
    }
  });
});
