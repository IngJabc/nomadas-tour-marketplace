import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/index.js';
import {
  captureException,
  fingerprintHttpError,
  shouldCaptureHttpStatus,
} from '../observability/sentry.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    if (shouldCaptureHttpStatus(err.statusCode)) {
      captureException(err, {
        tags: {
          service: 'api',
          status: err.statusCode,
          code: err.code,
        },
        fingerprint: fingerprintHttpError(err.statusCode, err.code),
      });
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: 'details' in err ? (err as any).details : undefined,
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  captureException(err, {
    tags: {
      service: 'api',
      status: 500,
      code: 'INTERNAL_ERROR',
    },
    fingerprint: fingerprintHttpError(500, 'INTERNAL_ERROR'),
  });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}
