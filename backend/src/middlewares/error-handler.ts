import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { AppError, InternalError } from '../errors/index.js';
import {
  captureException,
  fingerprintHttpError,
  shouldCaptureHttpStatus,
} from '../observability/sentry.js';

/**
 * SEC-02 — Copy público para fallos internos. No revela infraestructura,
 * base de datos, JWT ni mecanismos internos.
 */
const GENERIC_SERVER_MESSAGE =
  'No pudimos completar la operación en este momento. Inténtalo nuevamente.';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Identificador de solicitud: correlaciona la respuesta con logs/Sentry.
  const requestId = randomUUID();

  // InternalError: el mensaje crudo es interno y jamás se expone. Se responde
  // copy genérico + code; el detalle queda en logs y Sentry con el requestId.
  if (err instanceof InternalError) {
    console.error(
      `[${requestId}] Internal error (${err.code}, ${err.statusCode}):`,
      err.internalMessage ?? err.message,
    );
    if (shouldCaptureHttpStatus(err.statusCode)) {
      captureException(err, {
        tags: {
          service: 'api',
          status: err.statusCode,
          code: err.code,
          request_id: requestId,
        },
        context: {
          request_id: requestId,
          internal_message: err.internalMessage ?? err.message,
        },
        fingerprint: fingerprintHttpError(err.statusCode, err.code),
      });
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: GENERIC_SERVER_MESSAGE,
        request_id: requestId,
      },
    });
    return;
  }

  // AppError público (4xx y 5xx con copy autorizado): conserva su mensaje.
  if (err instanceof AppError) {
    if (shouldCaptureHttpStatus(err.statusCode)) {
      captureException(err, {
        tags: {
          service: 'api',
          status: err.statusCode,
          code: err.code,
          request_id: requestId,
        },
        fingerprint: fingerprintHttpError(err.statusCode, err.code),
      });
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: 'details' in err ? (err as any).details : undefined,
        request_id: requestId,
      },
    });
    return;
  }

  // Error no controlado: respuesta genérica, sin stack trace ni internals.
  console.error(`[${requestId}] Unhandled error:`, err);
  captureException(err, {
    tags: {
      service: 'api',
      status: 500,
      code: 'INTERNAL_ERROR',
      request_id: requestId,
    },
    context: { request_id: requestId },
    fingerprint: fingerprintHttpError(500, 'INTERNAL_ERROR'),
  });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: GENERIC_SERVER_MESSAGE,
      request_id: requestId,
    },
  });
}
