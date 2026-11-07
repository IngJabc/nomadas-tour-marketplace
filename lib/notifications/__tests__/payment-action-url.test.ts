/**
 * PAY-NOTIFICATIONS Task 8E — validación de `action_url`.
 *
 * Cubre: rutas internas válidas por tipo, cruce tipo/ruta, rechazo de URLs
 * externas o malformadas y la asociación del intento por `action_url` (nunca
 * por `entity_id`).
 */
import { describe, expect, it } from 'vitest';
import { parsePaymentActionUrl } from '../payment-action-url';

const ATTEMPT = '33333333-3333-4333-8333-333333333333';

describe('parsePaymentActionUrl', () => {
  it('acepta payment_verified con la ruta de boleto y devuelve el intento', () => {
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        `/account/purchases/${ATTEMPT}/ticket`,
      ),
    ).toEqual({
      href: `/account/purchases/${ATTEMPT}/ticket`,
      attemptId: ATTEMPT,
      type: 'payment_verified',
    });
  });

  it('acepta payment_rejected con la ruta de pago y devuelve el intento', () => {
    expect(
      parsePaymentActionUrl(
        'payment_rejected',
        `/account/purchases/${ATTEMPT}/payment`,
      ),
    ).toEqual({
      href: `/account/purchases/${ATTEMPT}/payment`,
      attemptId: ATTEMPT,
      type: 'payment_rejected',
    });
  });

  it('rechaza el cruce de tipo y ruta (verified→payment y rejected→ticket)', () => {
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        `/account/purchases/${ATTEMPT}/payment`,
      ),
    ).toBeNull();
    expect(
      parsePaymentActionUrl(
        'payment_rejected',
        `/account/purchases/${ATTEMPT}/ticket`,
      ),
    ).toBeNull();
  });

  it('rechaza URLs externas y con esquema', () => {
    expect(
      parsePaymentActionUrl('payment_verified', 'https://evil.test/ticket'),
    ).toBeNull();
    expect(
      parsePaymentActionUrl('payment_verified', 'http://evil.test/ticket'),
    ).toBeNull();
    expect(
      parsePaymentActionUrl('payment_verified', '//evil.test/ticket'),
    ).toBeNull();
    expect(
      parsePaymentActionUrl('payment_verified', `javascript:alert(1)`),
    ).toBeNull();
  });

  it('rechaza rutas que no sean la de compra con UUID de intento', () => {
    expect(
      parsePaymentActionUrl('payment_verified', '/account/reviews/res-1'),
    ).toBeNull();
    expect(
      parsePaymentActionUrl('payment_verified', `/account/purchases/att-1/ticket`),
    ).toBeNull();
    expect(
      parsePaymentActionUrl('payment_verified', '/account/purchases/'),
    ).toBeNull();
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        `/account/purchases/${ATTEMPT}/ticket/extra`,
      ),
    ).toBeNull();
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        `/account/purchases/${ATTEMPT}/ticket?x=1`,
      ),
    ).toBeNull();
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        `/account/purchases/${ATTEMPT}/ticket#frag`,
      ),
    ).toBeNull();
    expect(
      parsePaymentActionUrl(
        'payment_verified',
        ` /account/purchases/${ATTEMPT}/ticket`,
      ),
    ).toBeNull();
  });

  it('rechaza tipos que no son de pago o valores nulos', () => {
    expect(
      parsePaymentActionUrl('review_pending', '/account/reviews/res-1'),
    ).toBeNull();
    expect(parsePaymentActionUrl(null, `/account/purchases/${ATTEMPT}/ticket`)).toBeNull();
    expect(parsePaymentActionUrl('payment_verified', null)).toBeNull();
    expect(parsePaymentActionUrl('payment_verified', '')).toBeNull();
    expect(parsePaymentActionUrl('payment_verified', undefined)).toBeNull();
  });
});
