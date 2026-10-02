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
  - Acción de tarjeta: botón "Reservar" deshabilitado + "Próximamente"
    (se activa en MKT-003/004; evita links rotos)
  - Tests: `app/viajes/__tests__/page.test.tsx` (6 casos: render, filtros
    origen/destino/fecha con TZ de negocio, empty, error+reintento);
    `test-setup.ts` registra jest-dom (`vitest.config.ts` include de `app/`)
- [ ] **MKT-003** — Detalle de viaje + `BusLayout` (kia/bus, mismas reglas
  AGENTS.md)
- [ ] **MKT-004** — Wizard de reserva con lock TTL 900 (servidor decide)

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
