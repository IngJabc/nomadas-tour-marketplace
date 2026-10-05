# TASKS

> Documento **operativo del sprint**. Una tarea activa a la vez; marcar `[x]` al completar.
> **Estado:** Fase 0 (Bootstrap) completada — pendiente commit manual del usuario.
> **Visión de producto:** [`docs/ROADMAP.md`](docs/ROADMAP.md)
> **Contexto del proyecto:** [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md)
> **Contrato con nomadas-tour:** [`docs/NOMADAS_TOUR_INTEGRATION.md`](docs/NOMADAS_TOUR_INTEGRATION.md)
> **Guía de documentación:** [`docs/documentation-guide.md`](docs/documentation-guide.md)

---

## Sprint 0 — Bootstrap (2026-09-30)

- [x] **BOOT-001** — Repo + stack idéntica a `nomadas-tour`
  - `package.json`, `tsconfig`, `next.config`, `vitest`, `postcss`, `.gitignore`
- [x] **BOOT-002** — Frontend core
  - `app/` (layout, landing, login, register, viajes), `middleware.ts`,
    `lib/` (api, supabase, auth, errors, timezone, utils),
    `components/` (Navbar, Toast, AuthProvider)
- [x] **BOOT-003** — Backend Express 5
  - `/healthz` (GET+HEAD), `/api/auth` (login/register/me con rate limit),
    `/api/public/trips`, middleware auth (rol `customer`), error envelope,
    LockCleanup 60s, Sentry opcional, `app.test.ts`
- [x] **BOOT-004** — Documentación completa en `docs/`
  - PROJECT_CONTEXT, NOMADAS_TOUR_INTEGRATION, architecture, system-spec,
    business-rules (6 revisiones consolidadas), permissions, ROADMAP,
    documentation-guide + `TASKS.md` + `AGENTS.md`
- [x] **BOOT-005** — Validación (2026-09-30)
  - `npm install` raíz + backend ✓ (1.ª vez requirió `--legacy-peer-deps`
    por bug npm 10.2.5 `edgesOut`; con lockfile ya no hace falta)
  - `npm run build` (next build, 6 rutas) ✓
  - `npm run build --prefix backend` (tsc, exit 0) ✓
  - `npm test` → 9/9 ✓ · `npm run test --prefix backend` → 8/8 ✓
  - `npm run audit:deps` → 0 vulnerabilidades ✓
    (subida de seguridad `next` 16.3.5 → **16.3.8** por GHSA-vcvr-r3jv-pc5j
    — RCE crítica en `next/og`; `nomadas-tour` sigue en 16.3.5 con sus
    propias advisories `undici` pendientes)
  - Smoke dev: frontend `/`, `/login`, `/viajes` → 200 ✓ · backend
    `/healthz` → 200 ✓

---

## Próximo sprint — Fase 1 (Catálogo + Reserva)

Ver detalle en [`docs/ROADMAP.md`](docs/ROADMAP.md) § Fase 1.

- [x] **MKT-001** — Migraciones marketplace 074–079 (schema:
  `customer`, `reservations.customer_id/source/payment_status`, `payments`,
  `payment_allocations`, `platform_config`, `commissions`,
  `reservation_refunds`, `trips.installment_*`, RPC cancel por pasajero)
  - Escritas el 2026-09-30 en **`../nomadas-tour/supabase/migrations/`**
    (historia única de migraciones — no en este repo)
  - **Aplicadas a STAGING el 2026-10-02** (074–079, en orden). Falta producción
  - Decisiones tomadas al escribirlas:
    - `trips.seat_price` + `reservation_passengers.unit_price` (snapshot):
      el schema de tour **no tenía ninguna columna de precio**, sin ellas la
      fórmula de saldo de `business-rules.md` §3 no era calculable
    - `payment_status` es **derivado** (`pending|partial|fully_paid|refunded|
      cancelled`), NULL en reservas `internal`
    - Estados agregados a `reservations.status`: `locked`, `reserved`
      (ninguno de los de tour se eliminó)
    - `audit_log` ampliado para admitir `actor_role='customer'` y la acción
      `reservation.passenger_cancelled` (CHECK ampliados, nada quitado)
  - Archivos en UTF-8 sin BOM, solo ASCII (evita el mojibake de los SQL viejos)
- [x] **MKT-002** — Buscador público (origen/destino/fecha) contra
  `GET /api/public/trips` (2026-10-02)
  - `app/viajes/page.tsx`: fetch al catálogo, filtros origen/destino/fecha
    (filtrado client-side; el backend aun no aplica los query params),
    skeleton de carga, estado de error con reintentar, empty state y
    "sin resultados" con CTA, tarjetas con badge, fecha y capacidad
  - Acción de tarjeta: "Reservar" → Link a `/viajes/[id]`
    (activado en MKT-003; antes era botón deshabilitado)
  - Tests: `app/viajes/__tests__/page.test.tsx` (6 casos: render, filtros
    origen/destino/fecha con TZ de negocio, empty, error+reintento);
    `test-setup.ts` registra jest-dom (`vitest.config.ts` include de `app/`)
- [x] **MKT-003** — Detalle de viaje + `BusLayout` (kia/bus, mismas reglas
  AGENTS.md) (2026-10-02)
  - Backend `GET /api/public/trips/:id` (`backend/src/routes/public/trips.ts`):
    valida UUID (404 `TRIP_NOT_FOUND`), trips con `seat_price` /
    `installment_*` + `routes`, ofertas vía `trip_agencies` +
    `agencies.status='active'` + `agency_settings`, seats
    (`id, seat_code, status`), `availability` por estado y
    `lock_ttl_seconds`; errores 500 con código
  - Tests backend: `backend/src/routes/public/trips.test.ts` (7 casos)
  - Frontend `app/viajes/[slug-or-id]/page.tsx` (cliente; `params` Promise +
    `use()`): skeleton, detalle (ruta, fecha/hora TZ de negocio, precio con 2
    decimales y abono, badges de disponibilidad), ofertas como radiogroup
    seleccionable, mapa de asientos con selección **visual sin lock**
    (MKT-004), aviso de sin disponibilidad, datos incompletos (precio nulo /
    sin ofertas), 404 con CTA al catálogo, error + reintentar; CTA "Continuar
    con la reserva" deshabilitado hasta MKT-004
  - `components/bus/layouts.ts` + `BusLayout.tsx`: layouts estáticos kia (10) /
    bus (31) con pasillo central, puerta frontal con label vertical, cabina
    guía + conductor, ruedas, leyenda SIEMPRE encima, FONDO arriba / FRENTE
    abajo, estados y colores AGENTS.md; solo asientos existentes en `seats`
    con `available` (o ya seleccionados) son clicables
  - `lib/api.ts`: tipos `PublicTripDetail` (+offers/seats/availability) y
    `tripDetail`; `lib/price.ts`: `formatSeatPrice` (`$20,20`, es-VE)
  - Tests frontend: `app/viajes/[slug-or-id]/__tests__/page.test.tsx` (8) +
    `components/bus/__tests__/BusLayout.test.tsx` (5); suite total 28 en verde
- [x] **MKT-004** — Wizard de reserva con lock TTL 900 (servidor decide) +
  realtime (2026-10-05)
  - Backend: `backend/src/services/seat-lock.service.ts` (lock atómico con
    lazy-release de expirados, idempotencia por lock propio, rollback si otro
    adquiere, unlock solo de locks propios, `mySeatLocks`) +
    `backend/src/routes/public/seats.ts` (`POST /lock`, `POST /unlock`,
    `GET /locks` — auth `customer`, zod sin `ttl_seconds`, rate limit 120/min)
    montado en `app.ts`; TTL 900 lo decide el servidor (`LOCK_TTL_SECONDS`);
    cleanup existente en `backend/src/index.ts` (60s) sin worker nuevo
  - Frontend detalle `app/viajes/[slug-or-id]/page.tsx`: CTA "Continuar con
    la reserva" bloquea vía `seatApi.lockSeats`, escribe `mkt004.lock.v1` en
    sessionStorage, 401 → login, 409 → unlock + refetch + intersección
  - Frontend wizard `app/reservas/nueva/page.tsx`: 4 pasos (asientos →
    pasajeros → resumen → pago placeholder MKT-005), verificación dual
    (`tripDetail` + `mySeatLocks`), estados `loading/missing/expired/error`,
    countdown derivado de `lock_expires_at` (server), mínimo 1 asiento,
    "Cambiar asientos" libera todo, pasajeros con teléfono requerido y
    documentos duplicados rechazados
  - **Realtime** (patrón `nomadas-tour`): `lib/realtime/subscriptions.ts`
    (`subscribeToTripSeats`, `subscribeToTrips` sobre `postgres_changes` con
    RLS `*_public_read` + publicación `supabase_realtime`),
    `lib/booking/useSeatLocking.ts` (mapa en vivo, pérdida de asientos propios
    por `locked_by`, viaje cancelado/completado, refetch con debounce 500ms),
    `lib/booking/seat-map.ts` (`applySeatRow`/`removeSeatRow` con
    recount de disponibilidad)
  - Wizard en vivo: otro usuario toma tu asiento → deselect + toast + mapa
    actualizado; si se pierden todos → estado expirado; viaje cancelado /
    completado → toast + `clearLockState` + `/viajes`. Detalle en vivo:
    contadores y estados del mapa al día, selección suelta si otro toma tu
    asiento (con guardas para tu propio bloqueo en curso), viaje cancelado →
    404 con CTA
  - Archivos: `lib/api.ts` (`seatApi`), `lib/booking/{lock-state,passengers,
    useLockCountdown}.ts`, `components/booking/{LockCountdown,PassengerCard}.tsx`,
    `components/auth/AuthProvider.tsx` (`useOptionalAuthUser`)
  - Tests: `backend .../seats.test.ts` (15) +
    `app/viajes/[slug-or-id]/__tests__/page.test.tsx` (15) +
    `app/reservas/nueva/__tests__/page.test.tsx` (12) +
    `lib/booking/__tests__/useSeatLocking.test.ts` (10) +
    `lib/realtime/__tests__/subscriptions.test.ts` (7); suite total 64
    frontend + 30 backend en verde
  - **E2E staging verificado (2026-10-05)**: backend local contra Supabase
    staging con 2 customers reales — `POST /lock` 200 `ttl=900`; intento de
    forzar `ttl_seconds=5` → servidor mantiene 900; idempotencia (repetir
    devuelve mismos asientos); 409 `SEAT_LOCKED` para el otro usuario; request
    mixto [libre+tomado] → 409 sin adquirir ninguno (atómico); `GET /locks`
    devuelve los propios; 401 sin token; `unlock` → `unlocked=2` y seats
    `available`; TTL 5s (env `LOCK_TTL_SECONDS=5`) → expirado invisible en
    `GET /locks` y relevo por lazy-release. Limpieza: 0 locks y 0 usuarios
    de prueba en staging. Nota: RLS `seats_public_read` + publicación
    `supabase_realtime` confirmadas con anon key (lectura `seats`/`trips` OK)

---

## Después

| Orden | Tema | Estado |
| ----- | ---- | ------ |
| — | Fase 2 — Pagos (payments + allocations, panel admin) | Planificada |
| — | Fase 3 — Ciclo de vida (T-1, comisiones, refunds, emails) | Planificada |
| — | Fase 4 — Panel admin + /cuenta | Planificada |
| — | Gate `EMAIL_DELIVERY_MODE=disabled` antes de mandar emails reales | Recordatorio |
| — | Migrar `middleware.ts` → `proxy` (deprecación Next 16; evaluar en ambos repos) | Deuda técnica |

---

## Bloqueadores

_Ninguno._

---

## Ideas futuras

- Checkout como invitado (sin cuenta) — evaluar.
- WhatsApp como canal de notificación.
- Multi-moneda / precios por anticipada.
