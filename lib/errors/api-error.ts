export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getApiErrorMessage(
  error: unknown,
  fallback = 'Ocurrió un error',
): string {
  if (error instanceof ApiError) {
    // MKT-007.1: copy de cliente en lugar del texto crudo del backend,
    // que contiene jerga prohibida ("ventana de revisión", "plazo").
    if (error.code === 'CHECKOUT_WINDOW_EXPIRED') {
      return 'El tiempo de revisión expiró. Vuelve a intentar tu reserva.';
    }
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
