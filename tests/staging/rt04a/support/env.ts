/**
 * Configuración del harness de staging RT-04A.
 *
 * Reglas del harness (solo lectura):
 * - NUNCA se crean, modifican ni eliminan cuentas o datos.
 * - NUNCA se aprueban/rechazan pagos ni se generan reservas.
 * - NUNCA se imprimen tokens, claves, contraseñas, cookies ni valores de
 *   variables sensibles: solo se reporta presencia/ausencia (`<set>`/`<unset>`).
 *
 * Opt-in explícito: sin `STAGING_ALLOW=1` ninguna prueba de staging corre
 * (aislada de `npm test`, el build y CI por config de vitest separada).
 */

export interface StagingConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiUrl: string;
  customerAToken: string;
  customerBToken: string;
  attemptIdA: string | null;
  eligibleAttemptIdA: string | null;
  tripId: string | null;
  observe: boolean;
  observeWindowMs: number;
}

/** Opt-in. Sin esto, los describes de staging se saltean (sin red). */
export function stagingEnabled(): boolean {
  return process.env.STAGING_ALLOW === '1';
}

const REQUIRED_VARS = [
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_ANON_KEY',
  'STAGING_API_URL',
  'STAGING_CUSTOMER_A_TOKEN',
  'STAGING_CUSTOMER_B_TOKEN',
] as const;

function presence(name: string): string {
  return `${name}=${process.env[name] ? '<set>' : '<unset>'}`;
}

/**
 * Carga y valida la configuración. Lanza un error que lista SOLO nombres de
 * variables faltantes (nunca valores) si la configuración está incompleta.
 * No hace fallback a `NEXT_PUBLIC_*`: el operador debe apuntar de forma
 * explícita al proyecto de staging autorizado.
 */
export function loadStagingConfig(): StagingConfig {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      [
        'Configuración de staging incompleta. Faltan (solo nombres, sin valores):',
        ...missing.map((name) => `  - ${name}`),
        'Ningún valor sensible se imprime. Completa las variables y reintenta.',
      ].join('\n'),
    );
  }

  const supabaseUrl = process.env.STAGING_SUPABASE_URL as string;
  if (!/^https:\/\/.+/.test(supabaseUrl)) {
    throw new Error(
      'STAGING_SUPABASE_URL no parece un proyecto Supabase autorizado (se espera https://<proyecto>.supabase.co).',
    );
  }

  return {
    supabaseUrl,
    supabaseAnonKey: process.env.STAGING_SUPABASE_ANON_KEY as string,
    apiUrl: (process.env.STAGING_API_URL as string).replace(/\/+$/, ''),
    customerAToken: process.env.STAGING_CUSTOMER_A_TOKEN as string,
    customerBToken: process.env.STAGING_CUSTOMER_B_TOKEN as string,
    attemptIdA: process.env.STAGING_ATTEMPT_ID_A ?? null,
    eligibleAttemptIdA: process.env.STAGING_ELIGIBLE_ATTEMPT_ID_A ?? null,
    tripId: process.env.STAGING_TRIP_ID ?? null,
    observe: process.env.STAGING_OBSERVE === '1',
    observeWindowMs: Number(process.env.STAGING_OBSERVE_WINDOW_MS ?? '60000'),
  };
}

/** Reporte de presencia sin valores (seguro para consola). */
export function describeConfigPresence(cfg: StagingConfig): string {
  return [
    ...REQUIRED_VARS.map((name) => presence(name)),
    `STAGING_ATTEMPT_ID_A=${cfg.attemptIdA ? '<set>' : '<unset>'}`,
    `STAGING_ELIGIBLE_ATTEMPT_ID_A=${cfg.eligibleAttemptIdA ? '<set>' : '<unset>'}`,
    `STAGING_TRIP_ID=${cfg.tripId ? '<set>' : '<unset>'}`,
    `STAGING_OBSERVE=${cfg.observe ? '1' : '0'}`,
    `STAGING_OBSERVE_WINDOW_MS=${cfg.observeWindowMs}`,
  ].join('\n');
}

/**
 * Defensa en profundidad: elimina cualquier token/clave de un mensaje antes
 * de imprimirlo (por si un error de red o librería los ecoa).
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}
