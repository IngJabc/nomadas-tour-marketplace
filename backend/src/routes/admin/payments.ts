import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { requireAgency, verifyAgencyOwnership } from '../../middlewares/authorize.js';
import { ValidationError } from '../../errors/index.js';
import {
  getAgencyPaymentDetail,
  getPaymentProofSignedUrl,
  listAgencyPayments,
  rejectPayment,
  verifyPayment,
} from '../../services/payment.service.js';

const router = Router();

const uuidSchema = z.string().uuid();

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid input', result.error.issues);
  }
  return result.data;
}

const rejectBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

const listQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

/**
 * GET /api/admin/payments
 * Lista los pagos de la agencia autenticada (MKT-006 Fase 6.3B).
 *
 * - Auth obligatoria de rol `agency`; el `agency_id` de filtrado
 *   SIEMPRE sale de la sesión, nunca de la query.
 * - Filtro opcional `status` (pending|verified|rejected) y paginación
 *   `page`/`limit` (máx. 50). Orden: pendientes primero, luego
 *   `submitted_at` desc y `id` como desempate.
 * - No expone `proof_url`, documentos personales completos, tokens
 *   ni URLs privadas.
 */
router.get('/', auth, requireAgency, async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const result = await listAgencyPayments({
      agencyId: req.ctx!.agencyId!,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/payments/:paymentId
 * Detalle de un pago para revisión (MKT-006 Fase 6.3B).
 *
 * Reutiliza `verifyAgencyOwnership`: un pago inexistente y uno de otra
 * agencia producen el mismo 404. No expone la ruta del comprobante
 * ni documentos personales completos.
 */
router.get(
  '/:paymentId',
  auth,
  requireAgency,
  verifyAgencyOwnership('payment', 'paymentId'),
  async (req, res, next) => {
    try {
      const { paymentId } = parseOrThrow(
        z.object({ paymentId: uuidSchema }),
        req.params,
      );

      const result = await getAgencyPaymentDetail({
        paymentId,
        agencyId: req.ctx!.agencyId!,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/payments/:paymentId/proof
 * URL firmada de corta duración del comprobante (MKT-006 Fase 6.3B).
 *
 * - Auth + requireAgency + ownership (mismo 404 que detalle).
 * - La ruta se lee de `payments.proof_url` en el servidor; el cliente
 *   no aporta ninguna ruta de Storage.
 * - Valida que la ruta viva dentro del directorio de la reserva del
 *   propio pago antes de firmar.
 * - El bucket es privado; la URL firmada caduca en 300 s y no se
 *   registra en logs.
 */
router.get(
  '/:paymentId/proof',
  auth,
  requireAgency,
  verifyAgencyOwnership('payment', 'paymentId'),
  async (req, res, next) => {
    try {
      const { paymentId } = parseOrThrow(
        z.object({ paymentId: uuidSchema }),
        req.params,
      );

      const result = await getPaymentProofSignedUrl({
        paymentId,
        agencyId: req.ctx!.agencyId!,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/admin/payments/:paymentId/verify
 * Verifica un comprobante marketplace (RPC 085 `verify_marketplace_payment`).
 *
 * - Auth obligatoria de rol `agency`; el actor se deriva SIEMPRE de la
 *   sesión, nunca del body, la query ni los params.
 * - `verifyAgencyOwnership` comprueba en el servidor que el pago
 *   pertenece a la agencia autenticada (mismo 404 si no existe o es
 *   de otra agencia: no se filtra existencia ajena).
 * - El RPC es la autoridad de negocio: locks, allocations, importe
 *   exacto, idempotencia y auditoría. Aquí no se escribe nada directo.
 */
router.post(
  '/:paymentId/verify',
  auth,
  requireAgency,
  verifyAgencyOwnership('payment', 'paymentId'),
  async (req, res, next) => {
    try {
      const { paymentId } = parseOrThrow(
        z.object({ paymentId: uuidSchema }),
        req.params,
      );

      const result = await verifyPayment({
        paymentId,
        actorUserId: req.ctx!.userId,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/admin/payments/:paymentId/reject
 * Rechaza un comprobante marketplace (RPC 085 `reject_marketplace_payment`).
 *
 * Mismo patrón que verify: auth + requireAgency + ownership. El body
 * solo aporta el motivo (1-500 chars); el actor y el agency_id salen
 * de la sesión validada.
 */
router.post(
  '/:paymentId/reject',
  auth,
  requireAgency,
  verifyAgencyOwnership('payment', 'paymentId'),
  async (req, res, next) => {
    try {
      const { paymentId } = parseOrThrow(
        z.object({ paymentId: uuidSchema }),
        req.params,
      );
      const { reason } = parseOrThrow(rejectBodySchema, req.body);

      const result = await rejectPayment({
        paymentId,
        actorUserId: req.ctx!.userId,
        reason,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
