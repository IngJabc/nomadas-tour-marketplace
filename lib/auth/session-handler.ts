import toast from 'react-hot-toast';

const ACCOUNT_INACTIVE_MESSAGE = 'Tu cuenta ha sido desactivada por el administrador';
const FORCED_LOGOUT_KEY = 'forced_logout';
const FORCED_LOGOUT_VALUE = 'account_inactive';

let logoutInProgress = false;

export function isForcedLogout(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(FORCED_LOGOUT_KEY) === FORCED_LOGOUT_VALUE;
}

export function clearForcedLogout(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(FORCED_LOGOUT_KEY);
}

export function showAccountInactiveToast(): void {
  toast.error(ACCOUNT_INACTIVE_MESSAGE, { duration: 5000 });
}

export async function logoutInactiveAccount(): Promise<void> {
  if (logoutInProgress) return;
  logoutInProgress = true;

  showAccountInactiveToast();

  try {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    await supabase.auth.signOut();
  } catch {
    // SignOut should not block redirect
  }

  sessionStorage.setItem(FORCED_LOGOUT_KEY, FORCED_LOGOUT_VALUE);
  window.location.href = '/login';
}
