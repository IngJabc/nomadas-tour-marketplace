# Integración con Nómadas Tour

Este documento define **qué comparte** `nomadas-marketplace` con
`nomadas-tour`, qué es **EXTERNO (EXISTING)**, qué está **IMPLEMENTADO** y qué
está **PENDING IMPLEMENTATION**.

Referencia técnica: `../nomadas-tour` (solo lectura). No editar, migrar ni
commitear ese repo desde aquí.

---

## 1. Relación entre repos

| Repo | Rol | Dominio |
| ---- | --- | ------- |
| `nomadas-tour` | B2B multi-tenant | Agencias, viajes, reservas internas, boarding, operación |
| `nomadas-marketplace` (este) | B2C storefront | Catálogo público, cliente, reservas marketplace, pagos, comisiones |

Ambos apuntan al **mismo proyecto Supabase** (BD compartida). Las migraciones
de tour están en `../nomadas-tour/supabase/migrations` (001–073). Las del
marketplace arrancan en **074** y **viven también en el repo de tour**
(`../nomadas-tour/supabase/migrations/074…087_*.sql`), para mantener una sola
historia de migraciones. `supabase/migrations/` de este repo es solo un
puntero. Se aplican al MISMO proyecto, en orden estricto.

---

## 2. EXISTING — que ya existe en `nomadas-tour` y se REUTILIZA

| Activo | Ubicación (tour) | Uso en marketplace |
| ------ | ---------------- | ------------------ |
| Tablas `trips`, `routes`, `seats`, `trip_agencies`, `reservation_passengers` | `supabase/migrations/001–073` | Catálogo público + lock de asientos |
| RLS desde `public.users` (`private.auth_app_role/agency_id`) | `036`, `039` | Identidad y aislamiento |
| RPC de lock/release de asientos | `069_reservation_link_rpcs.sql`, `068_seat_lock_expires_at.sql` | Lock de asiento (con TTL servidor=900) |
| Outbox `outbox_events` + relay | `049–056`, `060` | Emails/notificaciones marketplace (futuro) |
| Estructura Express 5 + error envelope + `/healthz` | `backend/src/app.ts` | Patrón replicado en este repo |
| Auth middleware (Bearer + `public.users`) | `backend/src/middlewares/auth.ts` | Adaptado a rol `customer` |
| Design tokens, tipografía, componentes UI | `AGENTS.md`, `app/design-tokens.css` | Mismos tokens (AGENTS.md de este repo) |
| Layouts de vehículo (kia/bus) | AGENTS.md § mapa de asientos | Mismo componente BusLayout al reservar |

**Regla:** inspeccionar → identificar archivo/RPC/migration en tour → reutilizar
el patrón → **no inventar alternativas**.

---

## 3. EXISTING — que se crea en este repo

- `app/`: landing, `/login`, `/register`, `/viajes` (catálogo + detalle con
  mapa de asientos), `/reservas/nueva` (wizard + checkout con revisión).
- `backend/src/`: Express 5 con `/api/auth` (login/register/me) y
  `/api/public/trips`.
- `lib/`: API client con `authApi` + `publicApi`, supabase clients, AuthProvider.
- Docs de este repo (`docs/`).

---

## 4. IMPLEMENTADO — reglas de negocio (MKT-005…007)

Todo lo detallado en [`business-rules.md`](business-rules.md) está implementado
en el código (checkout_attempts, payments/allocations, revisión por intento):

1. TTL marketplace 900s / interno 600s, decidido por endpoint (cliente no
   envía `ttl_seconds`).
2. Flujo lock → comprobante ≤15 min → `locked → reserved` (sin extender lock).
3. `payments` + `payment_allocations` (sin tabla `installments`).
4. Rechazo inicial → cancelación atómica de la reserva; rechazo de abono →
   solo el pago.
5. Refunds de cliente en `reservation_refunds`; `agency_ledger` solo
   Nómadas↔Agencia.
6. T-1 por pasajero con `cancel_reservation_passenger` (separado del
   auto-complete T+3 de tour).
7. Comisión por pasajero al `trip.completed`, sin depender de `boarded`;
   fee global `platform_config.marketplace_commission_fee_cents` (30),
   idempotencia por `idempotency_key`.
8. Primer viaje gratis atómico por `trip_id + agency_id`
   (`agencies.first_marketplace_trip_completed_at`).
9. Verificación/rechazo por `payment_id` (nunca `reservation_id`).
10. `reservations.source` + `payment_status` derivado.

---

## 5. IMPLEMENTADO — schema marketplace (escrito 2026-09-30, aplicado)

Los SQL viven en `../nomadas-tour/supabase/migrations/` (historia única).
**074–080 verificados como aplicados en la BD compartida (en vivo 2026-10-06).**

| # | Item | Archivo | Notas |
| - | ---- | ------- | ----- |
| P1 | `customer` en `users.role_check` | `074_add_customer_role.sql` | ✅ Resuelto el CHECK por catálogo (011 no lo nombró). Sin esto, `/api/auth/register` falla |
| P2 | `reservations.customer_id`, `source`, `payment_status` | `075_reservations_marketplace.sql` | `payment_status` **derivado**, NULL en `internal`. Se **agregan** los estados `locked`/`reserved` sin quitar los de tour |
| P3 | `payments` + `payment_allocations` | `076_payments.sql` | Incluye `trips.seat_price` + `reservation_passengers.unit_price` (el schema no tenía precio) y el helper `reservation_passenger_balance()` |
| P4 | `platform_config`, `commissions`, `reservation_refunds` | `077_platform_config_commissions_refunds.sql` | Fee default 30 centavos, `idempotency_key` único, `agencies.first_marketplace_trip_completed_at` |
| P5 | `trips.installment_allowed`, `trips.installment_amount_cents` | `078_trips_installments.sql` | Sin tabla `installments` (el saldo se deriva) |
| P6 | RPC `cancel_reservation_passenger` | `079_cancel_reservation_passenger.sql` | Cancela 1 pasajero, libera su seat, crea refund `required`, idempotente. Amplía `audit_log` para `customer` |
| P7 | **MKT-007**: `checkout_attempts` + RPCs de checkout | `087_checkout_attempts.sql` | Tabla de intentos de compra, conciliación en `payments`, RPCs atómicas de verificación/rechazo. **Requiere migración en staging/producción** |

---

## 6. MKT-007 — Integración checkout_attempts (2026-10-13)

### Problema que resuelve

Antes de MKT-007 el flujo B2C creaba la reserva y el pago **antes** de que
la agencia revisara el comprobante. Si el pago era rechazado, la reserva y
los asientos ya estaban comprometidos.

### Solución

La compra nace como `checkout_attempts` (intento de compra). La reserva, el
pago y las allocations **solo se crean** en la aprobación atómica
`verify_checkout_attempt`.

### API pública (Marketplace backend)

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| POST | `/api/public/checkout/attempts` | Crear intento de compra (retiene asientos) |
| GET | `/api/public/checkout/attempts/:attemptId` | Ver estado del intento |
| POST | `/api/public/checkout/attempts/:attemptId/proof` | Subir comprobante con conciliación |
| POST | `/api/public/checkout/attempts/:attemptId/cancel` | Cancelar intento y liberar asientos |

### API de agencia (Tour backend)

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| GET | `/api/agency/checkout-attempts` | Listar intentos (filtros: status, trip_id, q) |
| GET | `/api/agency/checkout-attempts/:attemptId` | Detalle con conciliación |
| GET | `/api/agency/checkout-attempts/:attemptId/proof` | URL firmada del comprobante |
| POST | `/api/agency/checkout-attempts/:attemptId/verify` | Aprobar (crea reserva + pago atómicamente) |
| POST | `/api/agency/checkout-attempts/:attemptId/reject` | Rechazar con motivo |

### Frontend Tour

- `app/agency/payments/page.tsx`: toggle "Pagos" / "Compras" con filtros.
- `app/agency/payments/attempts/[id]/page.tsx`: detalle de compra con
  conciliación, pasajeros, acciones de verificar/rechazar/ver comprobante.

### Migración requerida

**087_checkout_attempts.sql** debe aplicarse en staging y producción antes
de desplegar este flujo. La migración:
- Crea la tabla `checkout_attempts`.
- Agrega columnas de conciliación a `payments`.
- Agrega `seats.checkout_attempt_id` + trigger de limpieza.
- Crea las RPCs de checkout.
- REVOKE sobre `create_marketplace_reservation` y `submit_marketplace_payment`.

### Endpoints legacy desactivados

- `POST /api/public/reservations` → `410 Gone` + `CHECKOUT_ATTEMPTS_REQUIRED`.
- `POST /api/public/reservations/:reservationId/payments` → `410 Gone` +
  `CHECKOUT_ATTEMPTS_REQUIRED`.
- `GET/POST /api/admin/payments/*` → `410 Gone` + `CHECKOUT_ATTEMPTS_REQUIRED`.
  La revisión de comprobantes de agencia vive exclusivamente en Tour
  (`/agency/payments`). Marketplace ya no expone acciones administrativas
  de verificación/rechazo.

### Política de rechazo

- Comprobante 1: envío inicial.
- Comprobante 2: primer reenvío después de un rechazo.
- Comprobante 3: segundo y último reenvío.
- Si se rechaza el comprobante 3, el intento pasa a `rejected_final` y
  libera únicamente los asientos que todavía pertenezcan a ese intento.
- No se permite un cuarto comprobante.
- Cada comprobante enviado abre una ventana de revisión de 24 horas.

---

## 7. REGLAS DE CONVIVENCIA

1. **No romper el contrato de tour**: si una migración marketplace cambia una
   tabla que tour lee, primero leer tour (`../nomadas-tour/supabase/migrations`)
   y validar impacto.
2. **No duplicar lógica de tour**: boarding, digests, reminders y reservas
   `internal` son de tour.
3. **Workers separados**: los flags de env del marketplace no deben encender
   schedulers de tour en esta BD (ojo: BD compartida ⇒ revisar flags en Render).
4. **Emails**: aplicar `EMAIL_DELIVERY_MODE` igual que tour antes de enviar
   anything real.
5. El TTL 900 es de este backend; no tocar `LOCK_TTL_SECONDS=600` de tour.

---

## 8. Env vars compartidas (advertencia BD compartida)

Ambos backends apuntan al mismo Supabase. En Render:

- `nomadas-tour` worker: flags F4/F5/WKR ya operativos (`true`).
- `nomadas-marketplace`: mantener flags en `false`/`disabled` hasta soak.
- Nunca encender `EMAIL_VIA_OUTBOX` en un servicio sin revisar el otro.

Detalle de env vars de este repo: [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md)
§ Environment.
