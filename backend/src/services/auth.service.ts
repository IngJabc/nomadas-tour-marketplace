import { supabase, supabaseAdmin } from '../config/database.js';
import { UnauthorizedError, ValidationError } from '../errors/index.js';

export class AuthService {
  async login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
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

    if (dbUser.role !== 'customer' && dbUser.role !== 'superadmin') {
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
      throw new ValidationError(error?.message || 'No se pudo crear la cuenta');
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

    if (userError) throw new ValidationError(userError.message);

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

    if (dbUser.role !== 'customer' && dbUser.role !== 'superadmin') {
      throw new UnauthorizedError('Usuario no registrado');
    }

    return { id: dbUser.id, email: dbUser.email, role: dbUser.role };
  }
}

export const authService = new AuthService();
