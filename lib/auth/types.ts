export type AppRole = 'customer' | 'superadmin';

/** Application identity from public.users via GET /auth/me */
export interface AppUser {
  id: string;
  email: string;
  role: AppRole;
  full_name: string | null;
}
