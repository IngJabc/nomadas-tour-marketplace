import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { supabaseAdmin } from './config/database.js';
import { expireStaleGuestSessions } from './services/guest-session.service.js';
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

// Auto-expiration for locked seats (every 60s).
// Marketplace TTL: env.LOCK_TTL_SECONDS (900). Interno/nomadas-tour: 600.
setInterval(async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from('seats')
      .update({
        status: 'available',
        locked_by: null,
        locked_at: null,
        lock_expires_at: null,
        guest_session_id: null,
      })
      .eq('status', 'locked')
      .lt('lock_expires_at', new Date().toISOString())
      .select();
    if (error) {
      console.error('[LockCleanup] Error:', error.message);
      captureException(new Error(error.message), {
        tags: { service: 'api', area: 'lock_cleanup' },
        fingerprint: fingerprintHttpError(500, 'LOCK_CLEANUP'),
      });
    } else if ((data || []).length > 0) {
      console.log(`[LockCleanup] Released ${data!.length} expired lock(s)`);
    }

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
