import { createClient } from '@/lib/supabase/client';

/**
 * Persiste la sesión devuelta por el backend (`/auth/login`, `/auth/register`)
 * en el cliente Supabase: a partir de ahí el AuthProvider, el middleware y el
 * header `Authorization` de `lib/api.ts` trabajan con la misma identidad.
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
    throw error;
  }
}
