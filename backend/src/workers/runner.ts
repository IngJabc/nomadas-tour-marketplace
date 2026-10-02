import 'dotenv/config';
import http from 'node:http';
import { env } from '../config/env.js';
import { initSentryFromEnv } from '../observability/init-from-env.js';
import { captureException, flushSentry } from '../observability/sentry.js';

/**
 * Worker runner — marketplace.
 *
 * PENDING IMPLEMENTATION: los handlers marketplace (T-1, comisiones, emails)
 * se registran aquí siguiendo el patrón de `nomadas-tour`
 * (`backend/src/workers/runner.ts`). Mientras no haya handlers, el proceso
 * solo expone /healthz para hosting tipo Render Free Web Service (WKR-006.4).
 */

initSentryFromEnv('worker');

process.on('uncaughtException', (err) => {
  console.error('[worker][uncaughtException]', err);
  captureException(err, {
    tags: { service: 'worker', status: 'fatal' },
    fingerprint: ['worker', 'lifecycle', 'uncaughtException'],
    level: 'fatal',
  });
  void flushSentry(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[worker][unhandledRejection]', reason);
  captureException(reason, {
    tags: { service: 'worker', status: 'fatal' },
    fingerprint: ['worker', 'lifecycle', 'unhandledRejection'],
    level: 'fatal',
  });
});

async function gracefulShutdown() {
  await flushSentry(2000);
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown(); });
process.on('SIGINT', () => { void gracefulShutdown(); });

// ── Health endpoint (liveness-only, sin DB) ────────────────────────────────
const healthServer = http.createServer((_req, res) => {
  const body = JSON.stringify({
    status: 'ok',
    service: 'nomadas-marketplace-worker',
    version: process.env.npm_package_version ?? 'unknown',
    uptime_seconds: Math.floor(process.uptime()),
    pid: process.pid,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(body);
});

healthServer.listen(env.WORKER_HEALTH_PORT, () => {
  console.log(
    `[Nomadas Marketplace Worker] health on :${env.WORKER_HEALTH_PORT} (${env.NODE_ENV})`,
  );
  console.log('[Nomadas Marketplace Worker] no handlers registered yet (PENDING)');
});
