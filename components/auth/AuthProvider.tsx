'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { authApi } from '@/lib/api';
import type { AppUser } from '@/lib/auth/types';

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let sharedMePromise: Promise<AppUser | null> | null = null;

async function fetchMeProfile(): Promise<AppUser | null> {
  if (sharedMePromise) return sharedMePromise;

  sharedMePromise = authApi
    .me()
    .then(({ user }) => user as AppUser)
    .catch(() => null)
    .finally(() => {
      sharedMePromise = null;
    });

  return sharedMePromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const userRef = useRef<AppUser | null>(null);
  userRef.current = user;

  const loadProfile = useCallback(async () => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      if (mountedRef.current) {
        setUser(null);
        setLoading(false);
      }
      return;
    }

    const profile = await fetchMeProfile();
    if (mountedRef.current) {
      setUser(profile);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    loadProfile();

    const supabase = createClient();
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'TOKEN_REFRESHED') return;
        if (event === 'SIGNED_OUT') {
          userRef.current = null;
          setUser(null);
          setLoading(false);
          return;
        }
        // El effect de arranque ya cargó el perfil; procesarlo de nuevo solo
        // provoca un segundo ciclo de carga.
        if (event === 'INITIAL_SESSION') return;
        // Supabase re-emite SIGNED_IN al recuperar la sesión cuando el usuario
        // vuelve a la pestaña. Si la identidad no cambió no hay nada que
        // recargar: recargar con `loading=true` reinicia las pantallas que
        // dependen de la sesión y provoca el parpadeo en blanco del checkout.
        if (session?.user?.id && session.user.id === userRef.current?.id) {
          return;
        }
        setLoading(true);
        loadProfile();
      },
    );

    return () => {
      mountedRef.current = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await loadProfile();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({ user, loading, refresh, signOut }),
    [user, loading, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthUser(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthUser must be used within AuthProvider');
  }
  return ctx;
}

/** Igual que useAuthUser pero sin lanzar fuera de AuthProvider (tests, rutas sueltas). */
export function useOptionalAuthUser(): AuthContextValue | null {
  return useContext(AuthContext);
}
