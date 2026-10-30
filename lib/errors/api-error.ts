/**
 * SEC-02 — Política centralizada de mensajes públicos de error.
 *
 * Regla de oro: el usuario final NUNCA debe ver `error.message` crudo de
 * Supabase, una respuesta sin envelope del backend, ni texto de una
 * excepción arbitraria. Los mensajes públicos se construyen desde códigos y
 * categorías controladas, no desde el texto del error.
 */

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

/** Copy público controlado, por categoría (SEC-02). */
export const PUBLIC_ERROR_MESSAGES = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos',
  SESSION_EXPIRED: 'Tu sesión ha expirado. Inicia sesión nuevamente.',
  SESSION_INVALID: 'No pudimos validar tu sesión. Inicia sesión nuevamente.',
  REGISTRATION_FAILED: 'No pudimos completar el registro. Inténtalo nuevamente.',
  CONNECTIVITY: 'No pudimos conectar con el servicio. Inténtalo nuevamente.',
  UNEXPECTED: 'Ocurrió un error inesperado. Inténtalo nuevamente.',
  RATE_LIMITED: 'Demasiados intentos. Espera un momento y vuelve a intentarlo.',
} as const;

/**
 * Códigos del backend que se traducen a copy público controlado. Para el
 * resto de códigos se conserva el mensaje del backend, que el servidor ya
 * sanea (nunca expone internals).
 */
const CODE_MESSAGE_OVERRIDES: Record<string, string> = {
  SESSION_EXPIRED: PUBLIC_ERROR_MESSAGES.SESSION_EXPIRED,
  SESSION_INVALID: PUBLIC_ERROR_MESSAGES.SESSION_INVALID,
  SESSION_ESTABLISH_FAILED: PUBLIC_ERROR_MESSAGES.SESSION_INVALID,
  // MKT-007.1: copy de cliente en lugar del texto crudo del backend,
  // que contiene jerga prohibida ("ventana de revisión", "plazo").
  CHECKOUT_WINDOW_EXPIRED: 'El tiempo de revisión expiró. Vuelve a intentar tu reserva.',
};

/**
 * Detecta un error del cliente Supabase Auth (AuthError/AuthApiError) sin
 * apoyarse en el texto del mensaje. Estos errores pueden contener internals
 * (p. ej. el fallo de verificación JWT ES256) que jamás deben renderizarse.
 */
function isSupabaseAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; status?: unknown; code?: unknown };
  return (
    e.name === 'AuthError' ||
    e.name === 'AuthApiError' ||
    (typeof e.status === 'number' && typeof e.code === 'string')
  );
}

/** Fallo de red del `fetch` (navegador): `TypeError` de conectividad. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * Devuelve SIEMPRE un mensaje público seguro. Nunca devuelve el `message`
 * crudo de un error que no sea `ApiError` (Supabase, red, excepción).
 */
export function getApiErrorMessage(
  error: unknown,
  fallback: string = PUBLIC_ERROR_MESSAGES.UNEXPECTED,
): string {
  if (error instanceof ApiError) {
    const override = CODE_MESSAGE_OVERRIDES[error.code];
    if (override) return override;
    // El backend sanea sus mensajes: se conservan para no perder contexto
    // útil (validación, reglas de negocio, credenciales).
    if (error.message) return error.message;
    return fallback;
  }

  // Errores NO-API: jamás exponer `error.message`.
  if (isSupabaseAuthError(error)) {
    return PUBLIC_ERROR_MESSAGES.SESSION_INVALID;
  }
  if (isNetworkError(error)) {
    return PUBLIC_ERROR_MESSAGES.CONNECTIVITY;
  }
  return fallback;
}

/**
 * Copy público para una respuesta HTTP sin envelope válido (p. ej. una página
 * de error devuelta por un proxy/CDN). Distingue sesión, conectividad y
 * error inesperado por la categoría del código de estado.
 */
export function publicMessageForStatus(status: number): string {
  if (status === 401) return PUBLIC_ERROR_MESSAGES.SESSION_INVALID;
  if (status === 408 || status === 429) return PUBLIC_ERROR_MESSAGES.RATE_LIMITED;
  if (status === 502 || status === 503 || status === 504) {
    return PUBLIC_ERROR_MESSAGES.CONNECTIVITY;
  }
  return PUBLIC_ERROR_MESSAGES.UNEXPECTED;
}
