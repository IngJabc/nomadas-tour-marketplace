import { createClient } from '@/lib/supabase/client';
import { ApiError, PUBLIC_ERROR_MESSAGES } from '@/lib/errors/api-error';

/**
 * Persiste la sesión devuelta por el backend (`/auth/login`, `/auth/register`)
 * en el cliente Supabase: a partir de ahí el AuthProvider, el middleware y el
 * header `Authorization` de `lib/api.ts` trabajan con la misma identidad.
 *
 * SEC-02: si `setSession` falla (p. ej. token emitido por otro proyecto
 * Supabase, o un error interno de verificación JWT como el fallo ES256), el
 * `AuthError` crudo de Supabase NUNCA se propaga. Se lanza un `ApiError`
 * controlado con mensaje público, para que el formulario muestre copy segura.
 */
export async function establishSupabaseSession(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    // Detalle interno solo en consola (sin los tokens); el usuario recibe
    // un mensaje público controlado.
    console.warn('[session] establishSupabaseSession failed:', error.name, error.status);
    throw new ApiError(
      PUBLIC_ERROR_MESSAGES.SESSION_INVALID,
      'SESSION_ESTABLISH_FAILED',
      401,
    );
  }
}
