import type { CheckoutAttemptStatus } from '@/lib/api';

/**
 * Mensaje simple por estado del intento de compra (MKT-007.1).
 *
 * Reglas de copy:
 * - Sin countdown ni números de tiempo.
 * - Sin el motivo del rechazo (`rejection_reason`).
 * - Sin contador de intentos (`proof_count` / `remaining_submissions`).
 * - Sin jerga ("ventana", "tiempo para", "plazo").
 *
 * El `status` es el estado CRUDO devuelto por `checkoutApi.getAttempt` y se
 * rehidrata en cada refresh de la pantalla de reserva.
 */
export function reviewMessage(
  status: CheckoutAttemptStatus | null | undefined,
): string {
  switch (status) {
    case 'created':
      return 'Tus asientos quedan retenidos mientras envías el comprobante.';
    case 'pending_review':
      return 'Tu comprobante está en revisión. Dentro de 24 horas recibirás respuesta.';
    case 'rejected':
      return 'Comprobante rechazado. Puedes enviar un comprobante válido.';
    case 'rejected_final':
      return 'Comprobante rechazado. No es posible enviar más comprobantes. Tus asientos quedaron liberados.';
    case 'verified':
      return 'Comprobante verificado. Tu reserva está confirmada.';
    case 'expired':
      return 'El tiempo de revisión expiró. Vuelve a intentar tu reserva.';
    case 'cancelled':
      return 'Esta compra fue cancelada. Tus asientos quedaron libres.';
    default:
      return 'Tu comprobante está en revisión.';
  }
}
