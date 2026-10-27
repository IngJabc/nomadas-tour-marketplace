/**
 * Soporte Realtime para el harness de staging RT-04A.
 *
 * Crea un cliente Supabase por cliente (A y B) autenticado con su propio
 * access token, igual que hace la app en el navegador. El socket Realtime se
 * autentica con el JWT del cliente (`realtime.setAuth`) para que Supabase
 * evalúe RLS con esa identidad al entregar eventos.
 *
 * El harness NO dispara transiciones de estado: solo observa eventos.
 */

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js';
import type { StagingConfig } from './env';

/** Decodifica el `sub` (customer id) del JWT de cliente sin imprimir el token. */
export function decodeJwtSub(token: string): string {
  const payloadPart = token.split('.')[1];
  if (!payloadPart) throw new Error('El token no parece un JWT (falta el payload).');
  const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
  const payload = JSON.parse(json) as { sub?: string };
  if (!payload.sub) throw new Error('El JWT no contiene el claim `sub`.');
  return payload.sub;
}

/** Cliente Supabase de un cliente (A o B) con su token, sin persistir sesión. */
export function createCustomerClient(cfg: StagingConfig, token: string): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface CapturedEvent {
  table: string;
  eventType: string;
  at: number;
}

export interface TableSubscription {
  table: string;
  filter?: string;
}

/**
 * Abre un canal `postgres_changes` autenticado como el cliente y acumula
 * eventos en `sink`. El filtro es el mismo que usa la app (p. ej.
 * `customer_id=eq.<customerId>`); la RLS real la evalúa el servidor.
 */
export function openCaptureChannel(
  client: SupabaseClient,
  token: string,
  label: string,
  tables: TableSubscription[],
  sink: CapturedEvent[],
): RealtimeChannel {
  client.realtime.setAuth(token);
  const channel = client.channel(`rt04a-harness:${label}:${Date.now()}`);
  for (const t of tables) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: t.table,
        ...(t.filter ? { filter: t.filter } : {}),
      },
      (payload: { eventType?: string }) => {
        sink.push({ table: t.table, eventType: String(payload.eventType), at: Date.now() });
      },
    );
  }
  return channel;
}

/** Suscribe y resuelve con el estado final del canal (o TIMEOUT). */
export function subscribeChannel(channel: RealtimeChannel, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
    channel.subscribe((status) => {
      if (
        status === 'SUBSCRIBED' ||
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
}

export async function closeChannel(
  client: SupabaseClient,
  channel: RealtimeChannel,
): Promise<void> {
  await client.removeChannel(channel);
}

/** Espera pasiva una ventana (ms) para que el operador ejecute una acción. */
export function waitWindow(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
