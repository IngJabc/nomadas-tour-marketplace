import { z } from 'zod';
import {
  normalizeEmailDeliveryMode,
  parseAllowedRecipients,
} from '../services/email-delivery-policy.js';

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(3003),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  CORS_ORIGIN: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  FRONTEND_URL: z.string().url(),
  /**
   * OPS-EMAIL-001 — Temporary Resend delivery gate.
   * normal | restricted | disabled (default normal).
   */
  EMAIL_DELIVERY_MODE: z
    .string()
    .optional()
    .transform((v) => normalizeEmailDeliveryMode(v)),
  /**
   * CSV allowlist used only when EMAIL_DELIVERY_MODE=restricted.
   * Empty list = fail-safe (skip all sends).
   */
  EMAIL_ALLOWED_RECIPIENTS: z
    .string()
    .optional()
    .transform((v) => parseAllowedRecipients(v ?? '')),
  /**
   * Marketplace lock TTL — el cliente NO envía ttl_seconds.
   * El servidor decide 900 (marketplace) vs 600 (interno/nomadas-tour).
   */
  LOCK_TTL_SECONDS: z.coerce.number().default(900),
  /** When true, ticket email is sent by outbox worker; HTTP path skips fire-and-forget. */
  EMAIL_VIA_OUTBOX: z
    .preprocess((v) => v === true || v === 'true' || v === '1', z.boolean())
    .default(false),
  /** When true, trip lifecycle effects will use outbox wiring; false keeps legacy behavior. */
  TRIP_EFFECTS_VIA_OUTBOX: z
    .preprocess((v) => v === true || v === 'true' || v === '1', z.boolean())
    .default(false),
  OUTBOX_POLL_MS: z.coerce.number().default(2000),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(10),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().default(10),
  /** WKR-006.2 — Sentry error monitoring (off by default). */
  SENTRY_ENABLED: z
    .preprocess((v) => v === true || v === 'true' || v === '1', z.boolean())
    .default(false),
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('production'),
  SENTRY_RELEASE: z.string().default(''),
  /**
   * WKR-006.4 — HTTP health port for worker process (Render Free Web Service).
   */
  WORKER_HEALTH_PORT: z.coerce.number().default(3002),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Environment validation failed:', result.error.flatten());
    throw new Error('Invalid environment variables');
  }
  return result.data;
}

export const env = loadEnv();
