import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/error-handler.js';

import authRoutes from './routes/auth/index.js';
import publicTripsRoutes from './routes/public/trips.js';

const app = express();

// Render terminates TLS at a load balancer and forwards X-Forwarded-For.
// Trust exactly 1 hop so req.ip / express-rate-limit see the client IP
// without allowing spoofing via trust proxy = true.
app.set('trust proxy', 1);

// Security
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN.split(',').map(s => s.trim()),
  credentials: true,
}));

// Body parsing
app.use(express.json());

// ── Health check (liveness-only) ─────────────────────────────────────────────
// Convención unificada con Worker: GET+HEAD /healthz
// No DB, no Supabase, no auth, no logs, no Sentry, no side effects.

function buildHealthPayload(): string {
  return JSON.stringify({
    status: 'ok',
    service: 'nomadas-marketplace-api',
    version: process.env.npm_package_version ?? 'unknown',
    uptime_seconds: Math.floor(process.uptime()),
    pid: process.pid,
  });
}

app.get('/healthz', (_req, res) => {
  const body = buildHealthPayload();
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.status(200).send(body);
});

app.head('/healthz', (_req, res) => {
  const body = buildHealthPayload();
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.status(200).end();
});

// Legacy endpoint kept for backward compatibility.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/public/trips', publicTripsRoutes);

// Error handler (must be last)
app.use(errorHandler);

export default app;
