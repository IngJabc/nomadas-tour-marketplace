export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Recurso no encontrado') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'No autorizado') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Prohibido') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class AgencyInactiveError extends AppError {
  constructor(message: string = 'Tu cuenta ha sido desactivada por el administrador') {
    super(message, 403, 'AGENCY_INACTIVE');
  }
}

export class AccountInactiveError extends AppError {
  constructor(message: string = 'Tu cuenta ha sido desactivada por el administrador') {
    super(message, 403, 'ACCOUNT_INACTIVE');
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Conflicto') {
    super(message, 409, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Error de validación', public details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class GoneError extends AppError {
  constructor(message: string = 'Gone', code: string = 'GONE') {
    super(message, 410, code);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string = 'Unprocessable entity', code: string = 'UNPROCESSABLE') {
    super(message, 422, code);
  }
}

/**
 * SEC-02 — Error interno 5xx cuyo mensaje crudo (Supabase, PostgreSQL,
 * PostgREST, JWT o RPC) NUNCA se expone al cliente. El `errorHandler`
 * responde con un mensaje público genérico + `request_id`; el detalle se
 * conserva solo en logs y Sentry para diagnóstico.
 *
 * Usar `InternalError` en lugar de `AppError(error.message, 500, ...)`
 * siempre que el mensaje provenga de una fuente interna.
 */
export class InternalError extends AppError {
  /** Detalle crudo para diagnóstico; jamás viaja en la respuesta. */
  readonly internalMessage?: string;

  constructor(code: string, internalMessage?: string, statusCode: number = 500) {
    // El mensaje PÚBLICO queda vacío: el handler lo reemplaza por copy genérico.
    super('', statusCode, code);
    this.name = 'InternalError';
    this.internalMessage = internalMessage;
  }
}
