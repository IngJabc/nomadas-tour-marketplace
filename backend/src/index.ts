import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { expireStaleGuestSessions } from './services/guest-session.service.js';
import { runPeriodicCheckoutCleanup } from './services/checkout-cleanup.service.js';
import { initSentryFromEnv } from './observability/init-from-env.js';
import {
  captureException,
  flushSentry,
  fingerprintHttpError,
} from './observability/sentry.js';

initSentryFromEnv('api');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  captureException(err, {
    tags: { service: 'api', status: 'fatal' },
    fingerprint: ['api', 'lifecycle', 'uncaughtException'],
    level: 'fatal',
  });
  void flushSentry(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  captureException(reason, {
    tags: { service: 'api', status: 'fatal' },
    fingerprint: ['api', 'lifecycle', 'unhandledRejection'],
    level: 'fatal',
  });
});

// Graceful shutdown — flush Sentry before exit (parity with Worker)
async function gracefulShutdown() {
  await flushSentry(2000);
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown(); });
process.on('SIGINT', () => { void gracefulShutdown(); });

// MKT-010: auto-expiración del checkout + locks de asientos (cada 60 s).
// 1) `cleanup_expired_checkout_attempts` (RPC 087) cierra los intentos
//    vencidos y libera SOLO sus locks — la autoridad del tiempo es la BD.
// 2) El release directo de locks vencidos excluye asientos de compras en
//    curso (`.is('checkout_attempt_id', null)`): esos solo los libera la
//    RPC en (1). Marketplace TTL: env.LOCK_TTL_SECONDS (900). Interno/
//    nomadas-tour: 600.
setInterval(async () => {
  try {
    await runPeriodicCheckoutCleanup();
    await expireStaleGuestSessions();
  } catch (err: any) {
    console.error('[LockCleanup] Error:', err.message);
    captureException(err, {
      tags: { service: 'api', area: 'lock_cleanup' },
      fingerprint: fingerprintHttpError(500, 'LOCK_CLEANUP'),
    });
  }
}, 60_000);

app.listen(env.PORT, () => {
  console.log(`[Nomadas Marketplace Backend] Running on port ${env.PORT} (${env.NODE_ENV})`);
});
