export type AppRole = 'customer' | 'agency' | 'superadmin';

/** Application identity from public.users via GET /auth/me */
export interface AppUser {
  id: string;
  email: string;
  role: AppRole;
}
