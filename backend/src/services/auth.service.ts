import { supabase, supabaseAdmin } from '../config/database.js';
import { InternalError, UnauthorizedError, ValidationError } from '../errors/index.js';

/**
 * SEC-02 — Traduce un error de Supabase Auth del registro a un error
 * PÚBLICO controlado. Se categoriza por el `code` que devuelve Supabase
 * (no por expresiones regulares sobre el mensaje) y jamás se expone el
 * texto crudo, que puede contener detalles internos.
 */
function registerPublicError(error: {
  code?: string;
  message?: string;
} | null): ValidationError {
  const code = (error?.code ?? '').toLowerCase();
  if (code === 'user_already_exists' || code === 'email_exists') {
    return new ValidationError('Ya existe una cuenta con este correo electrónico.');
  }
  if (code === 'weak_password') {
    return new ValidationError('La contraseña es demasiado débil. Elige una más segura.');
  }
  return new ValidationError('No pudimos completar el registro. Inténtalo nuevamente.');
}

export class AuthService {
  async login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      // Detalle interno solo en logs (sin la contraseña); el cliente recibe
      // el copy público controlado.
      console.warn('[auth] login failed:', error?.name, error?.status, error?.message);
      throw new UnauthorizedError('Correo o contraseña incorrectos');
    }

    const { data: dbUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('id', data.user.id)
      .single();

    if (userError || !dbUser) {
      throw new UnauthorizedError('Usuario no encontrado');
    }

    if (dbUser.role !== 'customer' && dbUser.role !== 'superadmin' && dbUser.role !== 'agency') {
      throw new UnauthorizedError('Esta cuenta no pertenece al marketplace');
    }

    return {
      token: data.session!.access_token,
      refresh_token: data.session!.refresh_token,
      user: { id: dbUser.id, email: dbUser.email, role: dbUser.role },
    };
  }

  async register(payload: { email: string; password: string }) {
    const { data, error } = await supabase.auth.signUp({
      email: payload.email,
      password: payload.password,
    });

    if (error || !data.user) {
      // Detalle crudo de Supabase solo en logs; el cliente recibe copy público.
      console.warn('[auth] register signUp failed:', error?.name, error?.status, error?.message);
      throw registerPublicError(error);
    }

    const { error: userError } = await supabaseAdmin
      .from('users')
      .upsert(
        {
          id: data.user.id,
          email: payload.email,
          password_hash: '',
          role: 'customer',
        },
        { onConflict: 'id' },
      );

    if (userError) {
      // Fallo real de base de datos: interno, jamás se expone el mensaje crudo.
      throw new InternalError('REGISTRATION_ERROR', userError.message);
    }

    const session = await supabase.auth.signInWithPassword({
      email: payload.email,
      password: payload.password,
    });

    if (session.error || !session.data.session) {
      return {
        token: data.session?.access_token ?? null,
        refresh_token: data.session?.refresh_token ?? null,
        user: { id: data.user.id, email: payload.email, role: 'customer' },
      };
    }

    return {
      token: session.data.session.access_token,
      refresh_token: session.data.session.refresh_token,
      user: {
        id: data.user.id,
        email: payload.email,
        role: 'customer',
      },
    };
  }

  async getMe(userId: string) {
    const { data: dbUser, error } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('id', userId)
      .single();

    if (error || !dbUser) {
      throw new UnauthorizedError('Usuario no encontrado');
    }

    if (dbUser.role !== 'customer' && dbUser.role !== 'superadmin' && dbUser.role !== 'agency') {
      throw new UnauthorizedError('Usuario no registrado');
    }

    return { id: dbUser.id, email: dbUser.email, role: dbUser.role };
  }
}

export const authService = new AuthService();
