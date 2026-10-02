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
