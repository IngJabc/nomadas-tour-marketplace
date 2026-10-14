# SYSTEM SPEC — MARKETPLACE B2C

Este documento resume la arquitectura y las reglas vigentes del marketplace.
Las migraciones y [`business-rules.md`](business-rules.md) prevalecen cuando
exista una diferencia con descripciones históricas.

---

# 1. VISIÓN GENERAL

Storefront público B2C para reservar asientos de viajes de agencias
conectadas, con pago por comprobante y comisiones por pasajero.

Roles: `CUSTOMER` (cliente) y `SUPERADMIN` (panel marketplace, PENDING).
El boarding y la operación de agencias NO viven aquí (ver
[`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md)).

---

# 2. STACK

- Frontend: Next.js 16.3.5 + TypeScript 5 + TailwindCSS v4
- Backend: Node.js + Express 5 (API separada, ESM)
- Database: Supabase (PostgreSQL) — proyecto compartido con `nomadas-tour`
- Auth: Supabase Auth (role `customer`)
- Testing: Vitest (frontend jsdom, backend node)

Detalle exacto: [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md).

---

# 3. IDENTIDAD (REGLA CENTRAL)

La identidad de aplicación se resuelve desde `public.users` después de validar
la sesión de Supabase Auth.

Reglas:

- El frontend nunca es fuente de autorización.
- El rol proviene de `public.users`, no de `user_metadata`.
- Los flujos del cliente filtran por `customer_id`.
- RLS defiende la BD compartida en profundidad.

---

# 4. REQUEST LIFECYCLE (OBLIGATORIO)

1. Validar el access token con Supabase Auth.
2. Resolver usuario y rol desde `public.users`.
3. Aplicar RBAC.
4. Inyectar contexto `{ userId, role, agencyId }`.
5. Controller → Service → datos → response.
6. Errores siempre por envelope `{ error: { code, message } }`.

---

# 5. ROLES

- `customer` → cliente del marketplace.
- `superadmin` → panel marketplace (PENDING).

No existen roles `admin` ni `user`. Los roles de operación (`agency`) son de
`nomadas-tour`.

---

# 6. CICLO DE VIDA DE UNA COMPRA MARKETPLACE (post-MKT-007)

1. Cliente selecciona asientos → se crea un **`checkout_attempt`** (lock de
   asientos con TTL 900s, servidor decide).
2. Cliente sube **comprobante** en ≤15 min → el intento pasa a `pending_review`
   (máx. 3 comprobantes; el 3er rechazo es definitivo).
3. Operador (agencia, panel en `nomadas-tour`) verifica → la RPC atómica
   `verify_checkout_attempt` crea la **reserva + pago + allocations** en una
   sola transacción.
4. Si a **T-1** (24h antes de la salida) un pasajero marketplace no está
   `fully_paid` → `cancel_reservation_passenger` **por pasajero** (libera su
   seat). *(Pendiente: MKT-008, worker.)*
5. Viaje completado → generación de comisiones (idempotente, por pasajero).

Estados del intento: `created → pending_review → (verified | rejected |
rejected_final | expired | cancelled)`.
Estados de la reserva: `locked → reserved → (cancelled | completed)`.
`payment_status` derivado: `pending | partial | fully_paid | refunded |
cancelled`.

> Los endpoints legacy `POST /api/public/reservations` y
> `POST /api/public/reservations/:reservationId/payments` devuelven
> `410 Gone` + `CHECKOUT_ATTEMPTS_REQUIRED`.

---

# 7. MAPA DE ASIENTOS

Mismas reglas físicas que `nomadas-tour` (AGENTS.md): layouts estáticos `kia`
(10) y `bus` (31), FONDO arriba, FRENTE abajo, solo IDs existentes en `seats`
son interactivos.

---

# 8. ENDPOINTS (implementados)

| Método | Ruta | Auth | Estado |
| ------ | ---- | ---- | ------ |
| GET | `/healthz` | no | Implementado |
| POST | `/api/auth/login` | no | Implementado |
| POST | `/api/auth/register` | no | Implementado |
| GET | `/api/auth/me` | Bearer | Implementado |
| GET | `/api/public/trips` | no | Implementado |
| POST | `/api/public/checkout/attempts` | Bearer | Implementado (MKT-007) |
| GET | `/api/public/checkout/attempts/:attemptId` | Bearer | Implementado (MKT-007) |
| POST | `/api/public/checkout/attempts/:attemptId/proof` | Bearer | Implementado (MKT-007) |
| POST | `/api/public/checkout/attempts/:attemptId/cancel` | Bearer | Implementado (MKT-007) |
| POST | `/api/public/reservations` | Bearer | **410 Gone** (legacy, `CHECKOUT_ATTEMPTS_REQUIRED`) |
| POST | `/api/public/reservations/:reservationId/payments` | Bearer | **410 Gone** (legacy) |
| GET | `/api/me/reservations` | Bearer | **PENDING** (MKT-013) |

---

# 9. PENDIENTES DE IMPLEMENTACIÓN

Ver [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md) § PENDING y
[`../TASKS.md`](../TASKS.md).

- Migraciones marketplace (074+): `customer` en `users.role_check`,
  `reservations.customer_id/source/payment_status`, `payments`,
  `payment_allocations`, `platform_config`, `commissions`,
  `reservation_refunds`, `trips.installment_*`, RPCs de lock 900s.
- Wizard de reserva + mapa de asientos + comprobante.
- Panel admin marketplace (pagos, comisiones).
- Workers marketplace (T-1, comisiones, emails).
