import { describe, expect, it } from 'vitest';
import type { CheckoutAttemptStatus } from '@/lib/api';
import { reviewMessage } from '../review-message';

const ALL_STATUSES: CheckoutAttemptStatus[] = [
  'created',
  'pending_review',
  'rejected',
  'rejected_final',
  'verified',
  'expired',
  'cancelled',
];

describe('reviewMessage (MKT-007.1)', () => {
  it('devuelve el copy exacto por estado del intento', () => {
    expect(reviewMessage('created')).toBe(
      'Tus asientos quedan retenidos mientras envías el comprobante.',
    );
    expect(reviewMessage('pending_review')).toBe(
      'Tu comprobante está en revisión. Dentro de 24 horas recibirás respuesta.',
    );
    expect(reviewMessage('rejected')).toBe(
      'Comprobante rechazado. Puedes enviar un comprobante válido.',
    );
    expect(reviewMessage('rejected_final')).toBe(
      'Comprobante rechazado. No es posible enviar más comprobantes. Tus asientos quedaron liberados.',
    );
    expect(reviewMessage('verified')).toBe(
      'Comprobante verificado. Tu reserva está confirmada.',
    );
    expect(reviewMessage('expired')).toBe(
      'El tiempo de revisión expiró. Vuelve a intentar tu reserva.',
    );
    expect(reviewMessage('cancelled')).toBe(
      'Esta compra fue cancelada. Tus asientos quedaron libres.',
    );
  });

  it('cae en el fallback neutro solo cuando no hay status', () => {
    expect(reviewMessage(null)).toBe('Tu comprobante está en revisión.');
    expect(reviewMessage(undefined)).toBe(
      'Tu comprobante está en revisión.',
    );
  });

  it('ningún mensaje lleva countdown, jerga de "ventana" ni contadores', () => {
    const messages = [...ALL_STATUSES.map(reviewMessage), reviewMessage(null)];

    for (const message of messages) {
      // Sin relojes tipo "1435:38" ni "HH:MM:SS".
      expect(message).not.toMatch(/\b\d{3,}:\d{2}\b/);
      expect(message).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      // Sin la jerga que motivó el fix.
      expect(message).not.toMatch(/ventana|plazo|tiempo para/i);
      // Sin exposición de intentos.
      expect(message).not.toMatch(/reenvíos?|restantes?|disponibles|intentos/i);
      // Sin el motivo del rechazo (lo decide el backend, jamás se copia).
      expect(message).not.toMatch(/ilegible|monto no coincide/i);
    }
  });
});
