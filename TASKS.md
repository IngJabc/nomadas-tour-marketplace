# TASKS

> Documento **operativo del sprint**. Una tarea activa a la vez; marcar `[x]` al completar.
> **Estado:** Fases 0–2 (Bootstrap, Catálogo+Reserva, Pagos) completadas + **RT-01/RT-02 (historial de compras), RT-03 (boleto QR)** completados + **RT-05 (reintento de pago)** y **MKT-009 (compras en paralelo)** implementados y validados localmente (pendiente staging). **Rutas en inglés (patrón tours) + filtros de Mis compras** completados (2026-10-26). Siguiente: **Fase 3 — Ciclo de vida (MKT-008 T-1)**. Migraciones marketplace 074–087 aplicadas.
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
  - **Aplicadas** (074–080 verificadas en vivo 2026-10-06; 085–087 aplicadas
    posteriormente). Historia única en el repo tour.
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
    (server), mínimo 1 asiento, "Liberar asientos" libera todo y reinicia la
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

## Fase 2 — Pagos y checkout (2026-10)

- [x] **MKT-006** — UI de revisión de pagos de agencia (2026-10-13)
  - Panel de agencia en `nomadas-tour` con listado, detalle, verificación
    y rechazo de pagos de marketplace.
  - Backend `nomadas-tour`: rutas agency payments (list/detail/proof/verify/
    reject) con `auth`, `authorize('agency')` y `tenant`.
  - Frontend `nomadas-tour`: `app/agency/payments` (listado con filtros),
    `[id]` (detalle con acciones), modales de verificación/rechazo/visor
    de comprobante.
  - Merge en `main` (PR #7).

- [x] **MKT-007** — Checkout pendiente de revisión y aprobación del pago (2026-10-13)
  - **Problema**: antes de MKT-007 el flujo B2C creaba la reserva y el pago
    ANTES de que la agencia revisara el comprobante. Si el pago era rechazado,
    la reserva y los asientos ya estaban comprometidos.
  - **Solución**: la compra nace como `checkout_attempts` (tabla nueva en
    migración 087). La reserva, el pago y las allocations solo se crean en la
    aprobación atómica `verify_checkout_attempt`.
  - **Migración** `../nomadas-tour/supabase/migrations/087_checkout_attempts.sql`:
    - Tabla `checkout_attempts` con estados `created | pending_review |
      rejected | verified | rejected_final | expired | cancelled`.
    - Columnas de conciliación en `payments`: `payment_reference`,
      `bank_origin`, `payment_datetime`.
    - `seats.checkout_attempt_id` + trigger `seats_clear_checkout_attempt`
      para tracking de asientos retenidos por un intento.
    - RPCs: `create_checkout_attempt`, `submit_checkout_proof`,
      `verify_checkout_attempt` (atómica: crea reserva + pago + allocations),
      `reject_checkout_attempt`, `cancel_checkout_attempt`,
      `cleanup_expired_checkout_attempts`.
    - REVOKE sobre `create_marketplace_reservation` y
      `submit_marketplace_payment` (endpoints desactivados).
  - **Backend Marketplace** (`nomadas-tour-marketplace/backend`):
    - Nuevas rutas `POST /api/public/checkout/attempts`,
      `GET /api/public/checkout/attempts/:attemptId`,
      `POST /api/public/checkout/attempts/:attemptId/proof`,
      `POST /api/public/checkout/attempts/:attemptId/cancel`.
    - `POST /api/public/reservations` y
      `POST /api/public/reservations/:reservationId/payments` devuelven
      `410 Gone` + `CHECKOUT_ATTEMPTS_REQUIRED`.
    - Rate limiting: create 30/min, submit 10/min, cancel 20/min
      (deshabilitado en `NODE_ENV=test`).
    - Validación de archivos (magic bytes, MIME, 5 MiB) en
      `checkout.service.ts`.
  - **Frontend Marketplace**:
    - `lib/api.ts`: `checkoutApi` (createAttempt, submitProof, getAttempt,
      cancelAttempt).
    - `lib/booking/lock-state.ts`: marcador `checkout_attempt` para
      persistir la compra entre renders.
    - `app/reservas/nueva/page.tsx`: flujo completo — creación de intento,
      subida de comprobante con conciliación, indicador de ventana de
      revisión, cancelación con modal de confirmación.
    - `components/booking/ProofUploader.tsx`: campos de conciliación
      (referencia, banco, fecha-hora), validación client-side.
    - `components/booking/LockCountdown.tsx`: modo `review` para la ventana
      de revisión.
    - `components/ui/ConfirmModal.tsx`: modal de confirmación reutilizable.
  - **Backend Tour** (`nomadas-tour/backend`):
    - Nuevas rutas agency: `GET /api/agency/checkout-attempts`,
      `GET /api/agency/checkout-attempts/:attemptId`,
      `GET /api/agency/checkout-attempts/:attemptId/proof`,
      `POST /api/agency/checkout-attempts/:attemptId/verify`,
      `POST /api/agency/checkout-attempts/:attemptId/reject`.
    - `checkout-attempt.service.ts`: listado con filtros (status, trip, q),
      detalle con conciliación, verificación atómica, rechazo con motivo.
  - **Frontend Tour**:
    - `lib/payments.ts`: tipos `AgencyCheckoutAttemptListItem`,
      `AgencyCheckoutAttemptDetail`, labels y badge variants.
    - `lib/api.ts`: `agencyApi.listCheckoutAttempts`, `getCheckoutAttempt`,
      `getCheckoutAttemptProof`, `verifyCheckoutAttempt`,
      `rejectCheckoutAttempt`.
    - `app/agency/payments/page.tsx`: toggle "Pagos" / "Compras" con filtros
      de estado por vista.
    - `app/agency/payments/attempts/[id]/page.tsx`: detalle de compra con
      conciliación, pasajeros, acciones de verificar/rechazar/ver comprobante.
    - `components/agency/payments/AgencyCheckoutAttemptCard.tsx`: tarjeta
      de listado.
    - `components/agency/payments/CheckoutAttempt{Verify,Reject,ProofViewer}
      Modal.tsx`: modales de acción.
  - **Endpoints legacy desactivados**:
    - `POST /api/public/reservations` → `410 CHECKOUT_ATTEMPTS_REQUIRED`.
    - `POST /api/public/reservations/:reservationId/payments` →
      `410 CHECKOUT_ATTEMPTS_REQUIRED`.
  - **Tests**:
    - Marketplace backend: `checkout.test.ts` (34 tests), `reservations.test.ts`
      (6), `payments.test.ts` (5), `guest-claim.test.ts` actualizado.
    - Marketplace frontend: `page.test.tsx` (66 tests), `ProofUploader.test.tsx`,
      `api-payment.test.ts`, `lock-state.test.ts`.
    - Tour frontend: `PaymentsPages.test.tsx` (+8 tests de compras).
  - **Pendiente de cierre**: aún falta probar en vivo atomicidad de
    `verify_checkout_attempt`, RLS y concurrencia (la expiración TTL sí está
    validada en staging — ver sección siguiente).

### Validación MKT-007 + MKT-008 en staging (2026-10-15)

- MKT-007 (expiración de intentos por TTL): validado end-to-end.
  - Intento `91771726-...` → `expired` tras forzar `expires_at`.
  - Asientos liberados (`status='available'`, `checkout_attempt_id` limpio).
  - UI cliente y agencia reflejan la expiración.
- MKT-008 (trigger outbox): validado.
  - Outbox event `checkout.expired_near_departure` con payload completo
    (`checkout_attempt_id`, `trip_id`, `customer_id`, `expired_at`).
- MKT-008 (RPC T-1 sobre reservas con saldo): pendiente de validación
  hasta que exista el flujo de abonos (MKT-010).
- MKT-007.2 (realtime de estado de pago al cliente): pendiente.
- MKT-011 (notificación de expiración): pendiente.

---

## RT-01…RT-03 — Historial de compras + boleto QR (2026-10-20)

- [x] **RT-01** — Historial de compras (backend)
  - `listPurchaseHistory()` en `backend/src/services/checkout.service.ts`:
    un item por `checkout_attempt` propio del cliente, con estado derivado
    `buildPurchaseEstado`: `pendiente_comprobante`, `en_revision`,
    `rechazado`, `rechazado_final`, `aprobado`, `reserva_confirmada`,
    `expirado`, `cancelado`, `desconocido`.
  - `GET /api/public/checkout/attempts` (Bearer + `requireCustomer`):
    lista paginada de las compras propias; nunca expone ajenas.
  - `reserva_confirmada` **solo** con reserva `reserved` + `fully_paid` +
    fila de reserva existente (estado ≠ pago; enviar comprobante nunca basta).
- [x] **RT-02** — Historial de compras (frontend)
  - `/cuenta/compras` → `app/cuenta/compras/page.tsx`: badges de estado,
    pasajeros con asientos en orden natural (A1, A2, …, A10), estados
    vacíos/loading/error y `retry`.
  - Acción **"Ver boleto"** solo si el backend marca `can_view_ticket`
    (reserva confirmada con `ticket_code` real) — RT-03 decide elegibilidad.
  - `Navbar`: enlace "Mis compras" solo para rol `customer` autenticado.
  - Folio/`attempt_id` **oculto en pantalla** (solo en el href del boleto).
- [x] **RT-03** — Boleto QR (backend + frontend)
  - `getCheckoutTicket()` + `GET /api/public/checkout/attempts/:attemptId/ticket`:
    exige reserva `reserved` + `fully_paid`; 404 uniforme `TICKET_NOT_FOUND`
    (no filtra por estado); devuelve `qr_code`/`ticket_code` de la migración
    087 **sin regenerar**.
  - `/cuenta/compras/[attemptId]/boleto` → `components/compras/PurchaseTicket.tsx`
    con `react-qr-code@^2.2.0` (mismo componente/valor que
    `ReservationTicket` de Tour) y descarga PNG con `html-to-image@^1.11.13`
    sobre el nodo visible (`boleto-<ticket_code>.png`).
  - Un **un** QR por reserva; el escáner y las RPC de abordaje de
    `nomadas-tour` **no cambian**.
  - Reglas AGENTS ya presentes y respetadas: todos los asientos en el
    boleto (regla 13) y "Salida" = `departure_time` del viaje (regla 14).
- Validación (2026-10-20): frontend **271/271** (19 archivos) · backend
  **272/274** (los 2 fallos son preexistentes: `085-payment-admin-actions`
  y `auth.test.ts` de roles) · `tsc --noEmit` raíz ✓ y backend ✓ ·
  `next build` ✓ (ruta `ƒ /cuenta/compras/[attemptId]/boleto`) ·
  `git diff --check` ✓.
- Dependencias: `+react-qr-code`, `+html-to-image`; se descartó `qrcode`
  de la primera iteración (nunca llegó a commit).

---

## RT-05 — Reintento de pago de compra rechazada (2026-10-22)

- [x] **RT-05** — Reintento de pago limitado a la etapa de checkout del intento original
  - **CTA en Mis compras**: `esReintentoDisponible` en
    `app/cuenta/compras/page.tsx` — la acción **«Corregir pago y
    reintentar»** (`RefreshCw`, primaria cyan) solo aparece en compras con
    `estado === 'rechazado'` y `puede_reenviar_comprobante`; enlaza a
    `/cuenta/compras/[attemptId]/pago`. Ningún otro estado ofrece la acción.
  - **Nueva ruta** `/cuenta/compras/[attemptId]/pago`
    (`app/cuenta/compras/[attemptId]/pago/page.tsx`): recupera el checkout
    original **solo en su etapa de pago** — nunca repite selección de
    asientos ni registro de pasajeros (los reutiliza del intento).
  - **Resumen y formulario**: resumen de compra (ruta, salida, agencia,
    asientos en orden natural, pasajeros con documento — sin teléfono —,
    importe y motivo del rechazo) + `PaymentMethodSection` (métodos de la
    agencia, `frozen` en `agency_direct`) + `ProofUploader` con **precarga
    editable** de la conciliación anterior (`initialValues`;
    `fromIsoToLocalInput` invierte `toIsoDatetime` sin tocar el wizard) y
    **envío de un comprobante nuevo** vía la misma `submitProof`.
  - **Validaciones de apertura**: el formulario solo se muestra si el
    intento es `rejected`, la ventana de checkout (`expires_at`) sigue
    abierta, quedan envíos disponibles (`remaining > 0`) y **sus** asientos
    siguen bloqueados en `mySeatLocks` (fail closed: sin verificar locks no
    hay envío). El resto de estados → bloqueo con copy neutro y CTA
    (`/viajes` o Mis compras); `pending_review`/aprobado → vista de revisión
    sin QR ni boleto.
  - **Manejo de errores**: 404 uniforme (inexistente o ajena, sin
    distinguir), 401 → sesión, `tripDetail` no crítico (fallbacks
    neutrales); backend `mapRpcError` traduce `ERR_CHECKOUT_LOCK_EXPIRED`
    (RPC 092) a **409 `CHECKOUT_SEATS_LOST`** en lugar de 500 genérico (sin
    pre-chequeo Node — TOCTOU); `onSubmitError` revalida contra el backend
    ante `CHECKOUT_SEATS_LOST`/`CHECKOUT_WINDOW_EXPIRED`.
  - **Realtime**: reutiliza la suscripción existente
    `subscribeToPurchaseTicket` con debounce 500 ms y guardas de secuencia;
    la revisión se muestra solo con confirmación del servidor (201 o 409
    `CHECKOUT_PROOF_PENDING`), sin QR antes de la verificación de la agencia.
  - **Tests (+27)**: `app/cuenta/compras/[attemptId]/pago/__tests__/page.test.tsx`
    (21), `components/booking/__tests__/ProofUploader.test.tsx` (+5),
    `app/cuenta/compras/__tests__/page.test.tsx` (+1 gate) y fixture
    `passenger_data` ajustado en el wizard.
- Validación local (2026-10-22): frontend **322/322** (20 archivos, suite de
  staging excluida) · `npx tsc --noEmit` ✓ · `next build` ✓ (ruta
  `ƒ /cuenta/compras/[attemptId]/pago`) · backend `npm run build` (tsc) ✓
  con `checkout.test.ts` **54/54** · `git diff --check` ✓ en ambos repos.
- **Estado**: implementado y validado localmente; **pendiente de validación
  funcional en staging**. Sin despliegue ni integración final. RT-05 no
  requiere migraciones: ninguna migración remota se aplicó ni se marca como
  aplicada.

---

## MKT-009 — Compras independientes en paralelo (2026-10-22)

- [x] **MKT-009** — iniciar una segunda compra sin destruir la compra en curso
  - **Sin migración**: el RPC `create_checkout_attempt` (087) ya rechaza con
    `ERR_CHECKOUT_SEAT_CLAIMED` los asientos reclamados por otro intento con
    set distinto — las compras en paralelo con asientos distintos ya eran
    válidas en servidor. El bloqueo era de UX y de aislamiento de locks.
  - **Banner de intento** (`app/reservas/nueva/page.tsx`): la compra en curso
    (created / pending_review / rejected) ofrece el botón **«Nueva compra»**
    (solo limpia estado local: sin `unlockSeats`/`unlockGuestSeats`, sin
    `cancelAttempt`, sin reintentos automáticos) y el link **«Ver mis
    compras»** → `/cuenta/compras`. Copy conservado íntegro del contrato
    RT-05: mensaje como hijo de texto del div `#fffbeb text-[#92400e]` sin
    svg; el uploader RT-05 sigue coexistiendo en `rejected`.
  - **Entrada a otro viaje**: si el borrador guardado tiene `attempt_id`, la
    rama cross-trip **no hace unlock** (evita el trigger de 087, que
    destruiría la compra), retira la selección local con `clearLockState()`,
    arranca el viaje nuevo y avisa con toast neutro «Tu compra en curso
    sigue activa. Síguela en Mis compras.» (react-hot-toast no expone
    `.info`: se usa el toast callable default).
  - **Aislamiento de locks** (`backend/src/services/seat-lock.service.ts`):
    `unlockSeatsForOwner` añade `.is('checkout_attempt_id', null)` — nunca
    libera locks con compra viva; `lockSeatsForOwner` responde **409
    `SEAT_LOCKED`** («Asientos de una compra en curso…») cuando el asiento
    tiene `checkout_attempt_id` (propia o ajena) **antes** de cualquier
    extensión de TTL: extender acortaría la ventana 900 s / 24 h y el
    trigger de 087 liberaría la compra.
  - **Tests (+9)**: wizard `page.test.tsx` +4 (describe «Compras
    independientes en paralelo»: cross-trip sin unlock ni cancelación,
    banner con ambas salidas sin crear nada, banner `pending_review`,
    banner `rejected` con RT-05 intacto); `seats.test.ts` +3 (filtro `.is`
    del unlock con `unlocked: 0`, 409 sobre asiento de compra propia con
    TTL intacto, 409 sobre asiento de compra ajena); `checkout.test.ts` +1
    (segunda compra paralela: 201 sin consultar `checkout_attempts` antes
    del RPC); `compras/__tests__/page.test.tsx` +1 (evento realtime: una
    compra avanza, la otra conserva estado, ruta e importe). Harnesses
    `seats` / `guest-seats` / `guest-claim` con `'is'` en `buildChain`.
- **Correcciones de tests obsoletos preexistentes** (rotos antes de MKT-009,
  sin relación con él): `085-payment-admin-actions-contract.test.ts` esperaba
  `FOR rec IN` tras el rename a `FOR v_rec IN` del compañero (ff3da77,
  MKT-007) y `auth.test.ts` esperaba 401 en login `agency` desde que 14aecc4
  (MKT-006) permitió ese rol — actualizado a 200 y el branch 401 ahora se
  cubre con un rol fuera del allowlist (`agent`).
- Validación local (2026-10-22): frontend **327/327** (20 archivos) ·
  `npx tsc --noEmit` ✓ · `next build` ✓ · backend **279/279** (17 archivos)
  · `npm run build` (tsc) ✓ · `git diff --check` ✓ en ambos repos · smoke
  dev: wizard y Mis compras 200 (:3002), `api/public/trips` 200 (:3003).
- **Estado**: implementado y validado localmente. **Sin migraciones nuevas
  (087 ya desplegada), sin variables de entorno nuevas ni cambios en Render**
  — nada que encender. Sin despliegue.

---

## Ajustes de conciliación del pago (2026-10-22)

- [x] **Campos del comprobante en `/reservas/nueva?trip=id`** (y por
  extensión en el reintento `/cuenta/compras/[attemptId]/pago`, que reutiliza
  `ProofUploader`):
  - **Referencia**: label «Referencia de la transferencia» → **«Referencia»**
    y solo números. `inputMode="numeric"` + `pattern="[0-9]*"` y
    `sanitizeReference()` aplicado al escribir y al hidratar `initialValues`;
    `validateReconciliation` añade el guard `La referencia debe contener solo
    números.` (defensa para llamadas directas).
  - **Banco**: label «Banco de origen» → **«Banco»**, de input libre a
    **select cerrado** con el catálogo `BANK_OPTIONS` exportado (los 7
    pedidos — Provincial, Banco de Venezuela, Mercantil, Banesco, BNC,
    Bancamiga, Bicentenario — más 100% Banco, Activo, Caroní, del Tesoro,
    Fondo Común (BFC), Plaza, Banplus, BOD, Bancaribe y Mi Banco). Opción
    vacía «Selecciona un banco»; un banco legado fuera del catálogo se
    conserva como opción extra en el reintento (sin pérdida de datos). Error
    de validación: «Selecciona el banco desde el que hiciste la
    transferencia.»
  - **Fecha y hora**: el input `datetime-local` se reemplaza por el
    **`DateTimePicker` de Tours** (el mismo del «Posponer viaje»), portado a
    este repo: `components/ui/DateTimePicker.tsx` +
    `components/ui/day-picker-calendar.tsx` (react-day-picker + date-fns/es,
    ya presentes en `package.json`; sin dependencias nuevas). El valor sigue
    siendo naive `YYYY-MM-DDTHH:mm`: `toIsoDatetime` /
    `fromIsoToLocalInput` y la tolerancia de futuro no cambian.
  - **Tests**: `ProofUploader.test.tsx` 35 (+5: dígitos al escribir,
    normalización de referencia legada, catálogo del select, ausencia de
    `datetime-local`, guard de `validateReconciliation`); el helper
    `fillReconciliation` de los 3 archivos fija la fecha con el día 1 del mes
    en curso vía el botón accesible del calendario y la hora en el input
    `time`, con payloads ISO calculados dinámicamente; fixtures de referencia
    pasan a ser numéricas.
- Validación local (2026-10-22): frontend **332/332** (20 archivos) ·
  `npx tsc --noEmit` ✓ · `next build` ✓ · `git diff --check` ✓ · smoke dev:
  `/reservas/nueva?trip=…` y `/cuenta/compras/att-1/pago` 200 (:3002).
- **Estado**: implementado y validado localmente. **Sin migraciones, sin
  variables de entorno nuevas, sin cambios de backend ni de Render**. Sin
  despliegue.

---

## MKT-010 — Expiración integral del checkout y liberación de asientos abandonados (2026-10-23)

> Nota de naming: el roadmap reservaba MKT-010 para el flujo de
> refunds/abonos (sigue pendiente en Fase 3; ver línea del "flujo de
> abonos" más arriba). La ejecución usó el identificador MKT-010 para esta
> tarea de expiración; refunds conserva su pendiente.

- **Causa raíz**: `cleanup_expired_checkout_attempts` (087 §10) existe y es
  correcta (SKIP LOCKED, idempotente, libera SOLO locks propios, cierra
  `created/pending_review/rejected` con `expires_at<=NOW()`) pero **nadie
  la invocaba** (la cabecera de 090 lo reconocía). El loop de 60 s de ambos
  backends y la edge function liberaban asientos con UPDATE blanket que el
  trigger de 087 convertía en `checkout_attempt_id = NULL`, dejando
  intentos huérfanos abiertos; `getAttempt` no validaba la ventana (un
  refresh a las +2 h seguía pintando "Compra iniciada"); el wizard no se
  suscribía a `checkout_attempts`.
- **Sin migración** (determinación documentada): el esquema y los RPCs
  087-094 son suficientes; la corrección es solo código de aplicación. No
  se creó, editó ni aplicó ninguna migración (ni en remoto ni local).
- **Backend marketplace**:
  - Nuevo `backend/src/services/checkout-cleanup.service.ts`:
    `runCheckoutCleanup()` (rpc `cleanup_expired_checkout_attempts`, nunca
    lanza, log+Sentry), `releaseExpiredSeatLocks()` (UPDATE blanket + guard
    `.is('checkout_attempt_id', null)`) y `runPeriodicCheckoutCleanup()`
    (cleanup **primero**, luego release protegido).
  - `backend/src/index.ts`: el loop de 60 s llama a
    `runPeriodicCheckoutCleanup` + `expireStaleGuestSessions` (antes el
    blanket era directo en el índice).
  - `checkout.service.ts` — `verifyAttemptReady`: orden terminal →
    ventana (si vencida: `runCheckoutCleanup()` + 409
    `CHECKOUT_WINDOW_EXPIRED`) → `pending_review` → proof_count: una
    revisión con +24 h vencidos ahora expira en lugar de "sigue en
    revisión". `getCheckoutAttempt`: expiración **perezosa** (si el intento
    está abierto y vencido, limpia y re-lee). `cancelCheckoutAttempt`: si
    el RPC responde `CHECKOUT_ATTEMPT_CLOSED` y la relectura da `expired`,
    devuelve éxito `{status:'expired', freed_seats:0}` (la cancelación
    sobre una compra ya expirada no es un error para el usuario).
- **Frontend marketplace**:
  - `app/reservas/nueva/page.tsx`: efecto realtime nuevo
    (`subscribeToPurchaseTicket` con debounce 500 ms) que solo dispara
    revalidación contra `getAttempt` — la autoridad del estado sigue en el
    backend; verify() sin flash de skeleton en revalidación; toast de
    cancelación con rama `expired` («Esta compra ya expiró…»).
  - `lib/api.ts`: `CancelCheckoutAttemptResult.status` →
    `'cancelled' | 'expired'`.
- **nomadas-tour** (partner operativo): el loop de 60 s de
  `backend/src/index.ts` y la edge function `release-expired-locks` llaman
  a `cleanup_expired_checkout_attempts` **antes** del UPDATE blanket y
  añaden el mismo guard `.is('checkout_attempt_id', null)` — la ventana
  600 s de Tour no se tocó.
- **Tests**: backend `checkout.test.ts` 60 (+6: GET perezoso expira y
  re-lee, GET tolera fallo del cleanup, ventana vencida dispara cleanup,
  `pending_review` vencido → `CHECKOUT_WINDOW_EXPIRED`, cancel `expired`
  → 200 con forma de éxito, cancel `rejected_final` → 409); nuevo
  `checkout-cleanup.service.test.ts` (7: RPC exacta, orden
  cleanup→release, guard de intentos, tolerancia a fallos); wizard
  `page.test.tsx` 113 (+3: ventana del servidor no se re-estampa,
  evento realtime revalida y pinta la expiración, cancel sobre intento
  expirado); contract test Tour `tests/security/checkout-expiry-cleanup.test.ts`
  (12 sobre el texto de 087: cierre acotado, locks propios, SKIP LOCKED,
  ventana del submit, herencia de TTL, sin pg_cron).
- **Ajuste UX posterior (2026-10-23)**: el banner de salidas («Nueva
  compra» / «Ver mis compras») ya NO aparece en estado `created` (mitad
  del pago, sin comprobante): solo en `pending_review`/`rejected` — es
  decir, cuando la parte del usuario del flujo terminó. En `created` la
  cabecera muestra el `LockCountdown` de la ventana de la compra
  (heredada del lock, corriendo en el servidor) y `handleExpired`
  revalida contra `getAttempt` al vencer (el cableado ya existía pero no
  se disparaba). Tests: wizard 113 (+1 creado con contador, −1 obsoleto
  del banner en `created`).
- Validación local (2026-10-23): marketplace frontend **337/337** (20
  archivos) · backend **291/291** (18 archivos) · Tour security
  **133/133** y suite completa **664 pass / 4 skip** ·
  `npx tsc --noEmit` ✓ y `npm run build` (tsc) en ambos backends ·
  `next build` ✓ en ambos fronts · `git diff --check` ✓ en ambos repos.
- **Estado**: implementado y validado localmente. **Sin migraciones
  nuevas, sin variables de entorno nuevas, sin cambios en Render** — nada
  que encender. Sin despliegue.

---

## Rutas en inglés + filtros de Mis compras (2026-10-26)

- [x] **Rutas del marketplace en inglés** (patrón del repo tours; renombrado
  de `app/` con `git mv`):
  - `/viajes` → `/trips`
  - `/reservas/nueva` → `/reservations/new`
  - `/cuenta/compras` → `/account/purchases`
  - `/cuenta/compras/[attemptId]/boleto` → `/account/purchases/[attemptId]/ticket`
  - `/cuenta/compras/[attemptId]/pago` → `/account/purchases/[attemptId]/payment`
  - `middleware.ts`: `protectedPaths` con las rutas nuevas (las viejas
    quedan como defensa) y públicas `/trips`, `/agencies`.
  - `next.config.ts`: redirects **308** de cada ruta vieja a la nueva
    (se evalúan antes que el middleware y conservan query params como
    `?trip=...`). Los enlaces viejos ya circulando siguen funcionando.
  - Reemplazo de referencias en todo el frontend (links, `router.push`,
    `?redirect=%2F...`, comentarios y tests). `routes.d.ts`/`validator.ts`
    son artefactos generados en `.next/` (gitignored) y se regeneran solos.
  - `AGENTS.md` § Estructura de pantallas actualizado con la convención
    (nunca crear rutas nuevas en español).
- [x] **Filtros en `/account/purchases`**:
  - El historial ahora se trae **completo** (páginas de 50 hasta agotar
    `has_more`; tope 20 × 50 = 1000 compras) para que los filtros busquen
    en TODO el historial, no solo en la pantalla visible.
  - Búsqueda de texto libre insensible a acentos y mayúsculas (ruta,
    agencia, asiento, pasajero, documento, boleto, referencia del
    comprobante y etiqueta de estado) contra un índice pre-normalizado por
    compra (un `Map`, sin re-normalizar en cada tecla).
  - Chips de estado en pill con contadores sobre todo el historial +
    chip "Todas (N)"; el activo se pinta en cyan (estado activo).
  - Rango de fecha de salida `desde`/`hasta` (día en la zona de negocio
    `America/Caracas` vía `toBusinessDateString`, inclusivos; una compra
    sin `departure_time` no pasa un filtro de fechas).
  - Contador de resultados ("Mostrando X de Y compras · N en total"),
    botón "Limpiar filtros" y empty state propio ("Ninguna compra
    coincide con tus filtros") con CTA que restaura el historial.
  - Paginación local de 5 tarjetas sobre el subconjunto filtrado: cambiar
    un filtro vuelve a la página 1, la página nunca queda fuera de rango y
    paginar jamás vuelve a llamar al backend. Un refresco realtime
    conserva los filtros activos; cambiar de identidad los limpia.
  - Ante un error nunca se limpia lo visible: un refresco fallido
    conserva la lista anterior y una carga parcial muestra lo traído más
    el banner de reintento (RT: regla de no limpiar selección del usuario).
- Tests: **346/346** (20 archivos): +9 de filtros y 3 reescritos de la
  paginación server-side a local (expectations `(5,0)` → `(50,0)`).
- Validación local (2026-10-26): `npm test` **346/346** ✓ ·
  `npx tsc --noEmit` ✓ · `npm run build` (`next build`) ✓ ·
  `git diff --check` ✓. **Sin commits.**
- **Estado**: implementado y validado localmente. **Sin migraciones ni
  variables de entorno nuevas; sin cambios en Render** — nada que
  encender. Sin despliegue.

---

## Margen de página consistente + DatePicker como estándar de filtros (2026-10-26)

- [x] **Contenedor unificado en todo el marketplace** (el mismo que usa el
  Navbar, `max-w-7xl mx-auto px-4 sm:px-6`):
  - Todas las páginas internas pasan a
    `mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16`:
    `/trips` (era `px-8`), `/reservations/new` (6 estados de carga, era
    `max-w-6xl sm:px-8`) y `/account/purchases` (era `max-w-4xl
    sm:px-8`).
  - Boleto y corrección de pago mantienen el 7xl y acotan su contenido
    con un wrapper interno (`max-w-2xl` el boleto, `max-w-3xl` el pago)
    para no estirar el documento.
  - `/login` y `/register` conservan el centrado pero con el mismo
    padding (`px-4 sm:px-6 pt-24 pb-16`, era `px-8`); la landing pasa de
    `px-8` a `px-4 sm:px-6`.
- [x] **`DatePicker` portado de Tours** como componente estándar
  (`components/ui/DatePicker.tsx`): botón + popover con el
  `DayPickerCalendar` del marketplace (locale español, "Limpiar fecha"),
  trigger calzado con los inputs vecinos (`rounded-[10px] py-3 pl-9
  pr-9 text-sm`, icono Lucide 16/1.75), prop `label` opcional con el
  label visible del patrón marketplace (asociado al botón) y
  `role="dialog"` en el popover (su cierre es animado: en tests hay que
  esperar a que desaparezca antes de abrir otro calendario).
- [x] **Los filtros de fecha nacen vacíos, sin fecha por defecto** (por
  decisión del producto: nada de "Cualquier fecha" / "Sin límite" ni
  prefill con hoy). El trigger muestra el placeholder `"Elige una fecha"`
  hasta que el usuario elige un día en el calendario; elegir una fecha
  aplica el filtro y la X / `Limpiar filtros` la vacía y muestra todo
  (catálogo completo / historial completo).
- [x] **`<input type="date">` nativos eliminados**:
  - `/trips`: el filtro "Fecha" ahora es el DatePicker (sin fecha por
    defecto, placeholder "Elige una fecha").
  - `/account/purchases`: "Salida desde" / "Salida hasta" ahora son dos
    DatePickers (ambos sin fecha por defecto y con el mismo placeholder).
    La lógica de filtrado no cambia: sigue comparando
    `toBusinessDateString` (día de negocio `America/Caracas`, inclusivo).
- Tests: los de fecha fijan días con clicks reales en el calendario
  (helpers `pickDate` + `dayButtonName`, navegación de mes por "Go to the
  Next Month") y verifican el placeholder "Elige una fecha" en su estado
  inicial; las fixtures de salidas pasaron a ser relativas a hoy
  (`isoAt(±n)` / `daysFromNow(n)`) para que envejezcan bien con el paso
  del tiempo.
- Documentación: `AGENTS.md` con la sección "Contenedor de página —
  margen estándar", la subsección "DatePicker (filtros de fecha)" y las
  reglas 20 (contenedor) y 21 (nunca `<input type="date">`).
- Validación local (2026-10-26): `npm test` **346/346** ✓ ·
  `npx tsc --noEmit` ✓ · `npm run build` (`next build`) ✓ ·
  `git diff --check` ✓ · smoke en dev (:3002): calendario abre en
  `/trips` con días en español, 0 errores de consola, `main` en
  1280px/24px de padding en `/trips`, `/` y `/login`.
- **Estado**: implementado y validado localmente. **Sin migraciones ni
  variables de entorno nuevas; sin cambios en Render** — nada que
  encender. Sin despliegue.

---

## Después

| Orden | Tema | Estado |
| ----- | ---- | ------ |
| — | Fase 2 — Pagos (payments + allocations, panel agencia) | ✅ Completada |
| — | Fase 3 — Ciclo de vida (T-1, comisiones, refunds, emails) | Planificada |
| — | Fase 4 — Panel admin + `/account` | Parcial (historial + boleto ✅ RT-01…03; perfil, mis reservas y /admin pendientes) |
| — | **MKT-007.1** — Modal WhatsApp de notificación de rechazo | Pendiente (ver detalle abajo) |
| — | Gate `EMAIL_DELIVERY_MODE=disabled` antes de mandar emails reales | Recordatorio |
| — | Migrar `middleware.ts` → `proxy` (deprecación Next 16; evaluar en ambos repos) | Deuda técnica |
| — | MKT-014 — Suite E2E de realtime (asientos, pagos, rechazos, expiraciones) | Planificada |

### MKT-007.1 — Modal WhatsApp de notificación de rechazo (Pendiente)

**Contexto:** La agencia ya puede rechazar un intento de compra desde
`/agency/payments/attempts/[id]` (MKT-007), escribiendo un motivo de rechazo.
Pero hoy no hay forma de avisar al reservante. Mientras no existe la API de
WhatsApp Business (futuro MKT-011 / emails outbox), la solución manual es
ofrecer a la agencia un **link `wa.me`** precargado.

**Flujo propuesto:**

1. La agencia rechaza el intento y confirma el motivo en el modal existente
   (`CheckoutAttemptRejectModal`).
2. **Tras confirmar**, aparece un **segundo modal**: «¿Desea notificar al
   reservante por WhatsApp?».
   - **Sí** → redirige a
     `https://wa.me/<booker_phone>?text=<mensaje_precargado>` en nueva pestaña.
   - **No** → cierra y vuelve al listado (comportamiento actual).
3. Si `attempt.booker.phone` es `null`, **no** ofrecer la opción; mostrar
   toast «No hay teléfono del reservante».

**Datos (ya disponibles en `checkout-attempt.service.ts`):**
- `attempt.booker.phone`, `attempt.booker.name`
- `attempt.rejection_reason`
- Pasajeros / asientos y datos del viaje (para el mensaje).

**Mensaje precargado (sugerido):**

```
Hola [nombre del reservante]:

Tu pago para la reserva de los asientos [A1, A2, …] del viaje
[Origen → Destino] del [fecha y hora de salida] con la agencia
[Nombre de la agencia] fue rechazado.

Motivo: [motivo ingresado por la agencia]

Por favor, contacta a la agencia o sube un nuevo comprobante desde
el enlace de tu reserva.

— Equipo Nómadas Tour
```

**Variables a interpolar:** `booker.name`, `seat_codes` (lista legible),
`trip_route`, `departure_time` (formato humano), `agency.name`,
`rejection_reason`.

**Notas de implementación:**
- Reutilizar el patrón `components/ui/ConfirmModal.tsx`.
- `wa.me` abre WhatsApp Web o la app nativa; no requiere API ni credenciales.
- Ligado a MKT-011 (emails outbox) como camino automático futuro.
- Repo donde vive la UI: **`nomadas-tour`** (panel de agencia).

---

## Bloqueadores

_Ninguno._

---

## Ideas futuras

- Checkout como invitado (sin cuenta) — evaluar.
- WhatsApp como canal de notificación.
- Multi-moneda / precios por anticipada.
