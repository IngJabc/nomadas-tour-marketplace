import { env } from '../config/env.js';
import {
  initSentry,
  type SentryService,
} from './sentry.js';

/** Resolve Sentry env with safe defaults (local off unless explicitly enabled). */
export function initSentryFromEnv(
  service: SentryService,
  defaultTags?: Record<string, string>,
): void {
  const environment =
    env.SENTRY_ENVIRONMENT.trim() || env.NODE_ENV || 'development';
  const release =
    env.SENTRY_RELEASE.trim() ||
    process.env.npm_package_version ||
    '1.0.0';

  initSentry({
    enabled: env.SENTRY_ENABLED,
    dsn: env.SENTRY_DSN,
    environment,
    release,
    service,
    defaultTags,
  });
}
