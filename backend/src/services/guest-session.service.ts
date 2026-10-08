import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { env } from '../config/env.js';
import { AppError, UnauthorizedError } from '../errors/index.js';

export type GuestSessionStatus = 'active' | 'claimed' | 'expired' | 'released';

export interface GuestSession {
  id: string;
  trip_id: string;
  customer_id: string | null;
  status: GuestSessionStatus;
  expires_at: string;
}

export interface GuestSessionResolution {
  session: GuestSession;
  created: boolean;
}

const GUEST_COOKIE_PREFIX = 'mkt_guest_lock_';
const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function guestCookieName(tripId: string): string {
  return `${GUEST_COOKIE_PREFIX}${tripId.toLowerCase()}`;
}

export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function guestTokenFromRequest(req: Request, tripId: string): string | null {
  const header = Array.isArray(req.headers.cookie)
    ? req.headers.cookie.join('; ')
    : req.headers.cookie;
  const token = parseCookies(header)[guestCookieName(tripId)] ?? null;
  if (!token || !GUEST_TOKEN_PATTERN.test(token)) return null;
  return token;
}

function cookieMaxAgeSeconds(expiresAt: string): number {
  const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  return Math.max(1, remaining);
}

function cookieAttributes(maxAgeSeconds: number): string {
  const secure = env.NODE_ENV === 'production';
  const attributes = [
    `Path=/api/public/seats`,
    'HttpOnly',
    `SameSite=${secure ? 'None' : 'Lax'}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function setGuestSessionCookie(
  res: Response,
  tripId: string,
  token: string,
  expiresAt: string,
): void {
  const maxAge = cookieMaxAgeSeconds(expiresAt);
  res.setHeader(
    'Set-Cookie',
    `${guestCookieName(tripId)}=${encodeURIComponent(token)}; ${cookieAttributes(maxAge)}`,
  );
}

export function clearGuestSessionCookie(res: Response, tripId: string): void {
  res.setHeader(
    'Set-Cookie',
    `${guestCookieName(tripId)}=deleted; ${cookieAttributes(1)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

export function refreshGuestSessionCookie(
  req: Request,
  res: Response,
  session: GuestSession,
): void {
  const token = guestTokenFromRequest(req, session.trip_id);
  if (!token) return;
  setGuestSessionCookie(res, session.trip_id, token, session.expires_at);
}

function guestSessionExpired(session: GuestSession): boolean {
  return Date.parse(session.expires_at) <= Date.now();
}

function isUsableSession(session: GuestSession, tripId: string): boolean {
  return session.trip_id === tripId && session.status === 'active';
}

async function findSessionByHash(
  tokenHash: string,
  tripId: string,
): Promise<GuestSession | null> {
  const { data, error } = await supabaseAdmin
    .from('guest_sessions')
    .select('id, trip_id, customer_id, status, expires_at')
    .eq('token_hash', tokenHash)
    .eq('trip_id', tripId)
    .maybeSingle();

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_QUERY_ERROR');
  }
  return (data as GuestSession | null) ?? null;
}

async function markSessionExpired(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('guest_sessions')
    .update({ status: 'expired' })
    .eq('id', sessionId)
    .eq('status', 'active');

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }
}

async function createSession(tripId: string): Promise<{ session: GuestSession; token: string }> {
  const ttlSeconds = env.LOCK_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomBytes(32).toString('base64url');
    const { data, error } = await supabaseAdmin
      .from('guest_sessions')
      .insert({
        trip_id: tripId,
        token_hash: hashGuestToken(token),
        status: 'active',
        expires_at: expiresAt,
      })
      .select('id, trip_id, customer_id, status, expires_at')
      .maybeSingle();

    if (!error && data) {
      return { session: data as GuestSession, token };
    }

    const duplicate = (error?.message ?? '').toLowerCase().includes('duplicate');
    if (!duplicate || attempt === 1) {
      throw new AppError(error?.message ?? 'No se pudo crear la sesión guest', 500, 'GUEST_SESSION_CREATE_ERROR');
    }
  }

  throw new AppError('No se pudo crear la sesión guest', 500, 'GUEST_SESSION_CREATE_ERROR');
}

export async function getOrCreateActiveGuestSession(
  req: Request,
  res: Response,
  tripId: string,
): Promise<GuestSessionResolution> {
  const token = guestTokenFromRequest(req, tripId);
  if (token) {
    const session = await findSessionByHash(hashGuestToken(token), tripId);
    if (session && isUsableSession(session, tripId)) {
      if (guestSessionExpired(session)) {
        await markSessionExpired(session.id);
        clearGuestSessionCookie(res, tripId);
        throw new AppError('La sesión guest expiró', 401, 'GUEST_SESSION_EXPIRED');
      }
      return { session, created: false };
    }
    clearGuestSessionCookie(res, tripId);
    if (session) {
      throw new UnauthorizedError('Sesión guest inválida');
    }
  }

  const created = await createSession(tripId);
  setGuestSessionCookie(res, tripId, created.token, created.session.expires_at);
  return { session: created.session, created: true };
}

export async function requireActiveGuestSession(
  req: Request,
  res: Response,
  tripId: string,
): Promise<GuestSession> {
  const token = guestTokenFromRequest(req, tripId);
  if (!token) {
    throw new UnauthorizedError('Sesión guest requerida');
  }

  const session = await findSessionByHash(hashGuestToken(token), tripId);
  if (session && session.status === 'claimed') {
    clearGuestSessionCookie(res, tripId);
    throw new AppError(
      'La sesión guest ya fue reclamada',
      409,
      'GUEST_SESSION_CLAIMED',
    );
  }
  if (!session || !isUsableSession(session, tripId)) {
    clearGuestSessionCookie(res, tripId);
    throw new UnauthorizedError('Sesión guest inválida');
  }

  if (guestSessionExpired(session)) {
    await markSessionExpired(session.id);
    clearGuestSessionCookie(res, tripId);
    throw new AppError('La sesión guest expiró', 401, 'GUEST_SESSION_EXPIRED');
  }

  return session;
}

export async function synchronizeSessionExpiry(sessionId: string, expiresAt: string): Promise<GuestSession | null> {
  const { data, error } = await supabaseAdmin
    .from('guest_sessions')
    .update({ expires_at: expiresAt })
    .eq('id', sessionId)
    .eq('status', 'active')
    .select('id, trip_id, customer_id, status, expires_at')
    .maybeSingle();

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }
  return (data as GuestSession | null) ?? null;
}

export async function markSessionReleased(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('guest_sessions')
    .update({ status: 'released' })
    .eq('id', sessionId)
    .eq('status', 'active');

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }
}

export async function releaseSessionIfUnused(sessionId: string): Promise<void> {
  const { data: activeLocks, error: locksError } = await supabaseAdmin
    .from('seats')
    .select('id')
    .eq('guest_session_id', sessionId)
    .eq('status', 'locked')
    .gt('lock_expires_at', new Date().toISOString())
    .limit(1);

  if (locksError) {
    throw new AppError(locksError.message, 500, 'GUEST_SESSION_QUERY_ERROR');
  }
  if ((activeLocks ?? []).length > 0) return;

  const { error } = await supabaseAdmin
    .from('guest_sessions')
    .update({ status: 'released' })
    .eq('id', sessionId)
    .eq('status', 'active');

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }
}

export async function expireStaleGuestSessions(now = new Date().toISOString()): Promise<{ expired: number }> {
  const { data, error } = await supabaseAdmin
    .from('guest_sessions')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', now)
    .select('id');

  if (error) {
    throw new AppError(error.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }
  return { expired: (data ?? []).length };
}

export function assertAllowedGuestOrigin(req: Request): void {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return;
  const allowed = env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
  if (!allowed.includes(origin)) {
    throw new AppError('Origen no permitido para la sesión guest', 403, 'FORBIDDEN');
  }
}
