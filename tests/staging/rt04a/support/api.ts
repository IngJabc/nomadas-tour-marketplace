/**
 * Cliente HTTP mínimo para el harness de staging RT-04A.
 *
 * Solo ejecuta GET (solo lectura). El header `Origin` se omite a propósito:
 * `assertAllowedGuestOrigin` del backend permite peticiones sin `Origin`
 * (patrón de fetch de Node / no-navegador), por lo que no hace falta
 * configurar un `STAGING_ORIGIN`.
 *
 * El token viaja SOLO en el header Authorization; nunca se registra.
 */

import type { StagingConfig } from './env';

export interface ApiResponse<T> {
  status: number;
  data: T | null;
  errorCode: string | null;
}

// Espejo estructural mínimo de los DTO de `lib/api.ts` (solo campos que el
// harness lee). Se define localmente para no ejecutar el runtime del cliente
// de la app (que depende de sesión de navegador).
export interface PurchaseItemMin {
  attempt_id: string;
  estado: string;
  reserva?: { ticket_code?: string | null } | null;
}
export interface PurchaseHistoryMin {
  items: PurchaseItemMin[];
}
export interface TicketViewMin {
  attempt_id: string;
  estado: string;
  qr_code: string;
  ticket_code: string;
}
interface ErrorBody {
  error?: { code?: string };
}

async function apiGet<T>(
  cfg: StagingConfig,
  token: string | null,
  path: string,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${cfg.apiUrl}${path}`, { headers });

  let data: T | null = null;
  let errorCode: string | null = null;
  try {
    const body = (await res.json()) as T & ErrorBody;
    data = body;
    errorCode = body?.error?.code ?? null;
  } catch {
    data = null;
  }
  return { status: res.status, data, errorCode };
}

/** GET /public/checkout/attempts — historial del cliente autenticado. */
export function listPurchases(
  cfg: StagingConfig,
  token: string,
): Promise<ApiResponse<PurchaseHistoryMin>> {
  return apiGet<PurchaseHistoryMin>(cfg, token, '/public/checkout/attempts?limit=50&offset=0');
}

/** GET /public/checkout/attempts/:id — detalle de UN intento (dueño). */
export function getAttempt(
  cfg: StagingConfig,
  token: string,
  attemptId: string,
): Promise<ApiResponse<unknown>> {
  return apiGet<unknown>(cfg, token, `/public/checkout/attempts/${attemptId}`);
}

/** GET /public/checkout/attempts/:id/ticket — boleto (404 uniforme si no elegible/ajeno). */
export function getTicket(
  cfg: StagingConfig,
  token: string,
  attemptId: string,
): Promise<ApiResponse<TicketViewMin>> {
  return apiGet<TicketViewMin>(cfg, token, `/public/checkout/attempts/${attemptId}/ticket`);
}

/** GET /public/trips — catálogo público (sin autenticación). */
export function listTrips(cfg: StagingConfig): Promise<ApiResponse<{ trips: unknown[] }>> {
  return apiGet<{ trips: unknown[] }>(cfg, null, '/public/trips');
}
