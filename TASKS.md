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
  - Acción de tarjeta: "Reservar" → Link a `/reservas/nueva?trip=<id>`
    (flujo directo al checkout desde el catálogo; `/viajes/[id]` ya no forma
    parte del recorrido — MKT-005)
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
  - Frontend detalle `app/viajes/[slug-or-id]/page.tsx`: **lock inmediato en
    el click** del asiento (`seatApi.lockSeats` por asiento; el usuario
    permanece en el mapa y acumula selección), re-click → `unlockSeats`,
    estado `heldSeats` con `lock_expires_at` / `locked_by` devueltos por el
    servidor, countdown derivado de la expiración **más próxima** entre los
    locks, pendientes por asiento (un lock en curso no bloquea el resto de la
    selección), `mkt004.lock.v1` en sessionStorage al pulsar "Continuar" (que
    ya **no** vuelve a lockear), restauración de locks vigentes al volver al
    viaje, 401 → login, 409 → toast + refetch **sin** unlock, keepalive
    `unlock` al desmontar salvo al navegar al wizard
  - Frontend `app/reservas/nueva/page.tsx`: **checkout de una sola página, sin
    stepper** (asientos + pasajeros + pago + comprobante visibles juntos),
    **entrada directa `?trip=<id>`** desde el catálogo (carga el viaje con 0
    asientos; la LockState se persiste recién con el primer asiento; una
    selección previa de OTRO viaje se libera y se recarga; `?trip=` se
    conserva en los redirects de login/registro), verificación dual
    (`tripDetail` + `mySeatLocks`, fallback `guest-locks` en 401/403),
    **locks por rol**: solo `customer` usa `/lock`+`/unlock`; invitados y
    cuentas no-customer (p. ej. superadmin) usan `lock-guest`/`unlock-guest`
    con la cookie — elegir asientos NUNCA redirige al login (el gate vive en
    el paso de pago), estados
    `loading/missing/expired/error`, countdown derivado de `lock_expires_at`
    (server), mínimo 1 asiento, "Cambiar asientos" libera todo y reinicia la
    selección **en la misma pantalla** (deshabilitado tras crear), pasajeros
    con teléfono requerido y documentos duplicados
    rechazados; creación con "Confirmar y pagar" (`handleCreate`, guard por
    `reservation_id` + dedupe en vuelo), tras el 201 se bloquea el formulario,
    el mapa pasa a solo-lectura y aparece la tarjeta de comprobante
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
    `app/viajes/[slug-or-id]/__tests__/page.test.tsx` (23) +
    `app/reservas/nueva/__tests__/page.test.tsx` (12) +
    `lib/booking/__tests__/useSeatLocking.test.ts` (10) +
    `lib/realtime/__tests__/subscriptions.test.ts` (7); suite total 72
    frontend + 40 backend en verde
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

## Fase actual — Guest Lock Ownership (Fase 4: frontend guest → auth → claim)

- [x] **GUEST-001** — Contrato aditivo de ownership guest en la historia compartida
  - Nueva migración `../nomadas-tour/supabase/migrations/080_marketplace_guest_lock_sessions.sql`
    (**aplicada** en el proyecto compartido — verificado en vivo 2026-10-06):
    `guest_sessions`, `seats.guest_session_id`, invariante de
    owner único, aislamiento por viaje y RLS solo `service_role`.
  - Sin endpoints, frontend ni claim/login en esta fase.
  - Contrato verificado con `backend/src/db/__tests__/guest-lock-ownership-schema.test.ts`.
- [x] **GUEST-002** — Backend guest lock/unlock/lookup sin autenticación
  - Nuevos endpoints `POST /api/public/seats/lock-guest`,
    `GET /api/public/seats/guest-locks` y `POST /api/public/seats/unlock-guest`.
  - Sesión guest por viaje con token aleatorio, hash SHA-256 y cookie HttpOnly;
    TTL 900 decidido por `env.LOCK_TTL_SECONDS`.
  - Dominio compartido para `locked_by` y `guest_session_id` con la misma
    validación, concurrencia condicional y atomicidad multiasiento.
  - Flujo autenticado existente intacto; claim/login y frontend guest quedan
    para fases posteriores.
- [x] **GUEST-003** — Claim/adopción guest→customer en backend
  - Nuevo endpoint `POST /api/public/seats/claim-guest` (auth customer +
    cookie guest, ignora ownership/TTL del body, invalida la cookie al final).
  - Transferencia atómica: reclamo condicional de la sesión (mutex) + un único
    `UPDATE` de seats sin tocar `lock_expires_at`, con compensación ante
    transferencia parcial.
  - `lock_expires_at` se preserva exactamente; sin reserva, pasajeros ni pago.
  - Sesión ya reclamada responde `409 GUEST_SESSION_CLAIMED` en endpoints guest.
- [x] **GUEST-003.1** — Validación real de Fase 3 contra Supabase (2026-10-06)
  - Migraciones 074–080 confirmadas aplicadas en el proyecto compartido.
  - E2E en staging: guest lock → claim → ownership customer con
    `lock_expires_at` idéntico, cookie invalidada, carrera A/B con un solo
    ganador, constraints (FK/CHECK/trigger/RLS) verificados en vivo.
  - Atomicidad del claim: mutex condicional + bulk `UPDATE` + compensación
    (lógica, no transaccional — ver informe Fase 3.1); residuo de pruebas: 0.
- [x] **GUEST-004** — Experiencia frontend: selección guest → login → claim
  - `lib/api.ts`: `request()` con `credentials: 'include'` (cookie HttpOnly
    cross-origin) y nuevos `seatApi.lockGuestSeats`, `getGuestLocks`,
    `unlockGuestSeats`, `claimGuestLocks` + tipos guest.
  - `lib/booking/guest-claim.ts`: helper compartido `claimPendingGuestLocks`
    (probe de pendientes → claim, outcomes `claimed | no-pending |
    already-claimed | expired | empty | conflict | error`, dedupe en vuelo).
  - `app/viajes/[slug-or-id]/page.tsx`: el visitante lockea con
    `lock-guest` (sin crear sesión autenticada), restaura su selección tras
    refresh solo con la cookie (`GET guest-locks`), countdown derivado del
    `lock_expires_at` del servidor, y al autenticarse dispara el claim UNA
    sola vez preservando TTL (sin re-lock). `HeldSeat.owner`
    (`guest|customer`) define qué endpoint se usa en toggle/keepalive/unmount.
  - `app/reservas/nueva/page.tsx`: claim pendiente ANTES de verificar con
    `mySeatLocks` (un guest post-login no sería propietario sin este paso).
  - Login y registro conectados al `authApi` + `AuthProvider` existentes
    (antes placeholders `disabled`): `establishSupabaseSession` +
    `auth.refresh()` + `router.push(safeRedirect)`; `?redirect=` solo
    internas (anti open-redirect).
  - Sin migraciones, sin RPC, sin tocar tour/payment/workers/email; el
    riesgo residual de atomicidad del claim NO se modificó.
  - Tests: `app/viajes/[slug-or-id]/__tests__/page.test.tsx` (+14 guest/claim
    → 37), `app/reservas/nueva/__tests__/page.test.tsx` (+3 claim → 15),
    nuevos `app/login/__tests__/page.test.tsx` (4) y
    `app/register/__tests__/page.test.tsx` (5).
  - **Pendiente de cierre**: E2E de browser (sin infraestructura de E2E en el
    repo), verificar `CORS_ORIGIN` en Render incluya el origin web (afecta a
    `assertAllowedGuestOrigin`), y el branch trip-mismatch del trigger
    (probable sin crear viaje solo para eso).

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
