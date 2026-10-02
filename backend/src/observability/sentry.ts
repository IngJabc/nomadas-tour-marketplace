/**
 * WKR-006.2 — Internal Sentry wrapper.
 * Rest of the app must use this module; do not import @sentry/node elsewhere.
 */
import * as Sentry from '@sentry/node';

export type SentryService = 'api' | 'worker';

export interface SentryInitOptions {
  enabled: boolean;
  dsn: string;
  environment: string;
  release: string;
  service: SentryService;
  /** Extra default tags (e.g. worker_name). */
  defaultTags?: Record<string, string>;
}

export type SentryTags = Record<string, string | number | boolean | null | undefined>;

export interface CaptureOptions {
  tags?: SentryTags;
  context?: Record<string, unknown>;
  fingerprint?: string[];
  level?: 'fatal' | 'error' | 'warning' | 'info';
}

const PII_KEY =
  /^(email|contact_email|password|phone|document|documento|qr_code|ticket_code|name|nombre|passenger|passengers|payload|to|recipient|ticket)$/i;

let active = false;
let bootstrapped = false;

function scrubRecord(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PII_KEY.test(key)) continue;
    if (value === undefined) continue;
    if (key === 'data' || key === 'body') continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Only allow flat ID-like nested bags; drop deep objects
      continue;
    }
    out[key] = value;
  }
  return out;
}

function normalizeTags(
  tags: SentryTags | undefined,
): Record<string, string> {
  if (!tags) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (PII_KEY.test(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/** Whether the wrapper will forward events to Sentry. */
export function isSentryEnabled(): boolean {
  return active;
}

/** Test helper — reset module state between tests. */
export function resetSentryForTests(): void {
  active = false;
  bootstrapped = false;
}

export function initSentry(options: SentryInitOptions): void {
  if (bootstrapped) return;
  bootstrapped = true;

  if (!options.enabled || !options.dsn.trim()) {
    active = false;
    return;
  }

  Sentry.init({
    dsn: options.dsn.trim(),
    environment: options.environment,
    release: options.release || undefined,
    // Error monitoring only — no performance / profiling in WKR-006.2
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (typeof event.request.url === 'string') {
          event.request.url = redactReservationLinkUrl(event.request.url);
        }
      }
      return event;
    },
  });

  active = true;
  setTags({
    service: options.service,
    environment: options.environment,
    ...(options.release ? { release: options.release } : {}),
    ...(options.defaultTags ?? {}),
  });
}

export function setTags(tags: SentryTags): void {
  if (!active) return;
  Sentry.setTags(normalizeTags(tags));
}

export function setContext(
  name: string,
  context: Record<string, unknown>,
): void {
  if (!active) return;
  Sentry.setContext(name, scrubRecord(context));
}

export function captureException(
  error: unknown,
  options: CaptureOptions = {},
): string | undefined {
  if (!active) return undefined;

  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : String(error));

  return Sentry.withScope((scope) => {
    const tags = normalizeTags(options.tags);
    if (Object.keys(tags).length > 0) scope.setTags(tags);
    if (options.context) {
      scope.setContext('details', scrubRecord(options.context));
    }
    if (options.fingerprint?.length) {
      scope.setFingerprint(options.fingerprint);
    }
    if (options.level) scope.setLevel(options.level);
    return Sentry.captureException(err);
  });
}

export function captureMessage(
  message: string,
  options: CaptureOptions = {},
): string | undefined {
  if (!active) return undefined;

  return Sentry.withScope((scope) => {
    const tags = normalizeTags(options.tags);
    if (Object.keys(tags).length > 0) scope.setTags(tags);
    if (options.context) {
      scope.setContext('details', scrubRecord(options.context));
    }
    if (options.fingerprint?.length) {
      scope.setFingerprint(options.fingerprint);
    }
    if (options.level) scope.setLevel(options.level);
    return Sentry.captureMessage(message, options.level ?? 'info');
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  if (!active) return true;
  return Sentry.flush(timeoutMs);
}

/** Stable fingerprints per design (WKR-006.2.1). */
export function fingerprintHttpError(
  statusCode: number,
  code?: string,
): string[] {
  return ['api', 'http', String(statusCode), code ?? 'INTERNAL_ERROR'];
}

export function fingerprintWorkerFailure(
  workerName: string,
  area: 'relay' | 'handler' | 'recovery' | 'lifecycle',
  handler?: string,
): string[] {
  return [
    'worker',
    workerName,
    area,
    handler ?? 'none',
  ];
}

const TOKEN_HEX_64 = /[a-f0-9]{64}/i;

/** Redact reservation-link tokens in path or `?token=` query. */
export function redactReservationLinkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (/\/reservation-links\//i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(
        /\/reservation-links\/[a-f0-9]{64}/i,
        '/reservation-links/[REDACTED]',
      );
    }
    if (parsed.searchParams.has('token')) {
      const raw = parsed.searchParams.get('token') || '';
      if (TOKEN_HEX_64.test(raw)) {
        parsed.searchParams.set('token', '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return url
      .replace(/\/reservation-links\/[a-f0-9]{64}/gi, '/reservation-links/[REDACTED]')
      .replace(/([?&]token=)[a-f0-9]{64}/gi, '$1[REDACTED]');
  }
}

/** Business / client HTTP statuses that must never be reported. */
const SILENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 410, 422]);

export function shouldCaptureHttpStatus(statusCode: number): boolean {
  if (SILENT_HTTP_STATUSES.has(statusCode)) return false;
  return statusCode >= 500;
}
