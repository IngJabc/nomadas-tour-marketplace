# PROJECT CONTEXT — Nómadas Marketplace

Documento maestro: **todo lo que hay que saber del proyecto** en un solo
lugar. Compañero de [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md)
(contrato con el repo hermano).

**Estado:** Bootstrap completado — skeleton buildable. Fase de implementación
de producto no iniciada (ver [`../TASKS.md`](../TASKS.md)).

**Última actualización:** 2026-09-30

---

## 1. Qué es

Storefront público B2C: el cliente busca viajes, elige asientos en el mapa del
vehículo, sube comprobante de pago y recibe boleto con QR. El marketplace
cobra comisión por pasajero a las agencias (primer viaje gratis).

NO es: panel de agencias, scanner de boarding, ni catálogo de pasajeros de
tour. Esos viven en `../nomadas-tour`.

---

## 2. Stack (idéntica a nomadas-tour)

| Capa | Tecnología | Versión |
| ---- | ---------- | ------- |
| Frontend | Next.js (App Router) | 16.3.8 |
| React | React | 19.2.4 |
| Lenguaje | TypeScript | ^5 (frontend) / ^5.8.3 (backend) |
| Estilos | Tailwind CSS v4 (`@tailwindcss/postcss`) | ^4 |
| UI | Lucide, CVA, clsx, tailwind-merge, Framer Motion | — |
| Toast | react-hot-toast | ^2.6.0 |
| Auth/DB | `@supabase/ssr` 0.12, `@supabase/supabase-js` 2.108.2 | — |
| Backend | Express (ESM, `type: module`) | ^5.1.0 |
| Validación | Zod | ^4.4.3 |
| Testing | Vitest (frontend `jsdom`, backend `node`) | ^4.1.11 |
| Email | Resend | ^6.17.2 |
| Observabilidad | Sentry (`@sentry/node`) | ^10.69.0 |
| Jobs | `tsx` (dev) / `node dist` (prod) | ^4.19.4 |

**Prohibido** (regla de stack): Fastify, NestJS, Prisma, Drizzle, GraphQL,
Redis, BullMQ, React Native, otra BD, otro auth, microservicios.

---

## 3. Estructura del repo

```
.
├── AGENTS.md / CLAUDE.md     → Reglas de diseño e implementación (obligatorio leer)
├── TASKS.md                  → Sprint operativo
├── README.md
├── package.json              → Scripts raíz (dev, build, test, dev:all, audit:deps)
├── tsconfig.json             → Alias @/*, bundler, strict
├── next.config.ts            → images.remotePatterns supabase.co
├── vitest.config.ts          → jsdom, TZ=UTC, alias @
├── postcss.config.mjs        → @tailwindcss/postcss
├── .env-example              → Variables del frontend
├── middleware.ts             → Protege /cuenta, /reservas (Supabase SSR)
├── app/
│   ├── layout.tsx            → Fonts Poppins+Montserrat, Navbar, ToastProvider
│   ├── globals.css           → Tailwind v4 @theme inline
│   ├── design-tokens.css     → Tokens de marca (single source of truth)
│   ├── page.tsx              → Landing pública
│   ├── login/page.tsx        → Login cliente (UI base)
│   ├── register/page.tsx     → Registro cliente (UI base)
│   └── viajes/page.tsx       → Buscador (empty state + CTA)
├── components/
│   ├── ui/                   → Navbar, BaseToast, ToastProvider
│   └── auth/                 → AuthProvider, RootProviders
├── lib/
│   ├── api.ts                → request() + authApi + publicApi
│   ├── supabase/             → client.ts (browser), server.ts (server)
│   ├── auth/                 → types (AppRole customer), session-handler
│   ├── errors/api-error.ts   → ApiError + getApiErrorMessage
│   ├── timezone.ts           → BUSINESS_TIMEZONE America/Caracas
│   └── utils.ts              → cn(), formatDateTime()
├── backend/
│   ├── package.json          → Scripts API/worker, ESM
│   ├── tsconfig.json         → ES2022 NodeNext, outDir dist
│   ├── vitest.config.ts      → node, src/**/*.test.ts
│   ├── .env-example          → Variables del backend (LOCK_TTL=900)
│   └── src/
│       ├── index.ts          → Boot + LockCleanup 60s + graceful shutdown
│       ├── app.ts            → /healthz, helmet, cors, rutas, errorHandler
│       ├── app.test.ts       → Tests trust proxy + healthz
│       ├── config/           → env.ts (Zod), database.ts (supabase clients)
│       ├── controllers/      → auth.controller.ts
│       ├── services/         → auth.service.ts, email-delivery-policy.ts
│       ├── middlewares/      → auth.ts (customer), error-handler.ts
│       ├── routes/           → auth/index.ts, public/trips.ts
│       ├── errors/           → AppError y amigos
│       ├── observability/    → sentry.ts, init-from-env.ts
│       ├── types/            → Role, RequestContext, tipos marketplace
│       └── workers/runner.ts → PENDING (handlers marketplace)
├── supabase/migrations/      → Migraciones marketplace (074+, PENDING)
└── docs/                     → Toda la documentación (ver §8)
```

---

## 4. Comandos

```bash
# Instalación
npm install                    # lockfile presente — funciona sin flags
npm install --prefix backend

# Nota: en la instalación inicial (sin package-lock.json) npm 10.2.5 puede
# fallar con "Cannot read properties of null (reading 'edgesOut')" (bug de
# arborist con peer deps de vitest). Workaround: --legacy-peer-deps.
# Con el lockfile ya generado, no hace falta.

# Desarrollo
npm run dev                # Next.js (3000)
npm run dev --prefix backend   # API (3001)
npm run dev:all            # ambos con concurrently

# Validación (OBLIGATORIA antes de declarar listo)
npm run build              # next build
npm run build --prefix backend   # tsc
npm test                   # vitest frontend
npm run test --prefix backend    # vitest backend
npm run audit:deps         # npm audit high (raíz + backend)

# Worker (solo cuando existan handlers; no correr contra prod sin revisión)
npm run worker --prefix backend
```

Regla AGENTS.md #19: `tsc --noEmit` **no** sustituye a `npm run build`.

---

## 5. Environment

Frontend (`.env`, ver `.env-example`):

```
NEXT_PUBLIC_SUPABASE_URL=         # proyecto Supabase compartido con tour
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_LOCK_TTL_SECONDS=900  # solo display; el TTL real lo decide el server
```

Backend (`backend/.env`, ver `backend/.env-example`):

```
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / JWT_SECRET
PORT=3001  NODE_ENV  CORS_ORIGIN  FRONTEND_URL
RESEND_API_KEY  EMAIL_FROM
EMAIL_DELIVERY_MODE=normal        # poner disabled antes de mandar emails reales
EMAIL_VIA_OUTBOX=false
LOCK_TTL_SECONDS=900              # marketplace (tour usa 600)
TRIP_EFFECTS_VIA_OUTBOX=false
OUTBOX_POLL_MS / OUTBOX_BATCH_SIZE / OUTBOX_MAX_ATTEMPTS
SENTRY_ENABLED=false  SENTRY_DSN / SENTRY_ENVIRONMENT / SENTRY_RELEASE
WORKER_HEALTH_PORT=3002
```

**Nunca commitear `.env`.** Ambos archivos contienen secretos reales.

**Setup local (2026-09-30):** existe un `.env` creado desde `.env-example`
con **placeholders**. Para desarrollo real hay que copiar los valores del
proyecto Supabase compartido desde `D:\nomadas-tour\.env` (mismo proyecto BD).
El backend no requiere `.env` para compilar; para correrlo sí (o env vars
inyectadas en el proceso).

**Warnings conocidos (no son errores):**

- `The "middleware" file convention is deprecated. Please use "proxy" instead`
  — Next.js 16 deprecó `middleware.ts`; `nomadas-tour` usa la misma
  convención. Migración pendiente con
  `npx @next/codemod@canary middleware-to-proxy .` (evaluar en ambos repos).
- Vitest avisa que `vitest.config.ts` es ESM en un package.json sin
  `"type": "module"` — mismo caso que tour; solo warning.

### ⚠️ Aviso Render (regla 18 AGENTS.md)

Este bootstrap **no añade env vars nuevas con defaults que enciendan algo**.
Si en el futuro se añade una flag con default `false`, el cierre DEBE indicar:
servicio (web/worker), valor soak y cuándo encenderla. La BD es compartida:
revisar siempre los flags del worker de `nomadas-tour` en Render.

---

## 6. Estado de implementación

| Área | Estado |
| ---- | ------ |
| Bootstrap (config, app, backend, docs) | ✅ Completado |
| Validación (build, tests, audit, smoke) | ✅ 2026-09-30: build raíz+backend ✓, tests 9/9 + 8/8 ✓, `audit:deps` 0 vulns ✓, dev `/healthz` 200 ✓ |
| Auth cliente (login/register/me) | ✅ API base + UI placeholder |
| Catálogo `/viajes` | ⚠️ Empty state (API pública devuelve viajes) |
| Wizard de reserva + mapa de asientos | ⏳ PENDING |
| Pagos/comprobantes + allocations | ⏳ PENDING (diseño aprobado) |
| Panel admin marketplace | ⏳ PENDING |
| Workers (T-1, comisiones) | ⏳ PENDING |
| Migraciones marketplace (074+) | ⏳ PENDING |
| Docs de diseño (6 auditorías) | ✅ Consolidadas en business-rules.md |

---

## 7. Decisiones de diseño aprobadas

Ver [`business-rules.md`](business-rules.md) (resumen):

- TTL 900s marketplace / 600s tour, decidido por endpoint.
- `payments` + `payment_allocations`; sin tabla `installments`.
- T-1 por pasajero (`cancel_reservation_passenger`).
- Comisión por pasajero sin depender de boarding; fee global 30 en
  `platform_config`; idempotente por `idempotency_key`.
- Primer viaje gratis atómico por `trip_id + agency_id`.
- Verificación de pago por `payment_id` individual.
- `agency_ledger` solo Nómadas↔Agencia; refunds en `reservation_refunds`.

---

## 8. Documentación (`docs/`)

| Doc | Pregunta que responde |
| --- | --------------------- |
| [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) | ¿Qué es este proyecto y cómo funciona? (este) |
| [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md) | ¿Cómo se conecta con nomadas-tour? |
| [`architecture.md`](architecture.md) | ¿Cómo está construido? |
| [`system-spec.md`](system-spec.md) | ¿Cuáles son las reglas funcionales? |
| [`business-rules.md`](business-rules.md) | ¿Qué decisiones de negocio están aprobadas? |
| [`permissions.md`](permissions.md) | ¿Qué puede hacer cada rol? |
| [`ROADMAP.md`](ROADMAP.md) | ¿Hacia dónde evoluciona? |
| [`documentation-guide.md`](documentation-guide.md) | ¿Dónde escribo cada cosa? |
| Raíz [`TASKS.md`](../TASKS.md) | ¿Qué hacemos ahora? |
| Raíz [`AGENTS.md`](../AGENTS.md) | ¿Cómo debe implementar el agente? |
