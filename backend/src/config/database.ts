import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const ADMIN_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
};

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, ADMIN_OPTIONS);

// Second client with the same key — NEVER used for auth.getUser(), so its auth
// state stays clean and all queries bypass RLS via the service_role key.
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, ADMIN_OPTIONS);

/**
 * Creates an isolated PostgREST client whose Authorization header contains the
 * verified end-user JWT. Queries made through this client are evaluated by RLS
 * as that user, including the private.auth_app_* identity helpers.
 */
export function createAuthenticatedClient(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    ...ADMIN_OPTIONS,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
