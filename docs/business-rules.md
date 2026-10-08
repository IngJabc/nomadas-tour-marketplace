# Reglas de negocio — Marketplace

Estado: **READY FOR IMPLEMENTATION** (6 revisiones de diseño aprobadas).
Este documento consolida las decisiones finales. Cualquier implementación que
lo contradiga está mal.

---

## 1. Roles

- `customer` — cliente del marketplace (este repo).
- `superadmin` — panel admin marketplace (PENDING).
- Los roles `superadmin`/`agency` de operación pertenecen a `nomadas-tour`.

---

## 2. Locks de asientos (TTL)

- **Marketplace: TTL 900s. Interno (`nomadas-tour`): TTL 600s.**
- El TTL se decide **internamente** por endpoint/contexto
  (`env.LOCK_TTL_SECONDS` = 900 en este backend).
- **El cliente NUNCA controla `ttl_seconds`.** El request no lo envía; si lo
  envía, se ignora.
- No cambiar `env.LOCK_TTL_SECONDS` del backend tour (600).
- Flujo: **lock → comprobante en ≤15 min → transición
  `locked → reserved`.**
- **NO** se extiende el lock 24h. El lock expira y libera el asiento.
- Cleanup: `index.ts` libera locks vencidos cada 60s (mismo patrón que tour).
- `reservation_links` **NO** es el flujo principal del marketplace (es el flujo
  asistido de tour, F5-004).

---

## 3. Pagos

- El cliente inicia la reserva y sube **comprobante** en ≤15 min.
- El comprobante es un registro en `payments` (estado `pending` →
  `verified` / `rejected`).
- **Modelo: `payments` + `payment_allocations`** — un comprobante puede
  cubrir N pasajeros. `payment_allocations` liga `payment_id` con
  `reservation_passenger_id` y el monto asignado.
- **NO existe tabla `installments`.** El saldo se deriva:
  `saldo(pax) = seat_price − SUM(allocations verified)`.
- Configuración de abono: `trips.installment_allowed`,
  `trips.installment_amount_cents` (columnas creadas en 078).
- **Fuente del precio (decidido 2026-09-30 al escribir la migración 076):**
  el schema de tour **no tenía ninguna columna de precio**, sin ellas la
  fórmula de saldo no era calculable. Se agregaron:
  - `trips.seat_price` — precio vigente del viaje, en centavos.
  - `reservation_passengers.unit_price` — snapshot congelado al reservar.
  El saldo se calcula con el **snapshot**, no con `trips.seat_price`, para que
  un cambio de precio posterior no altere saldos ya pactados.
  Helper de solo lectura: `public.reservation_passenger_balance(pax_uuid)`.
- **Rechazo de pago inicial** → `cancel_agency_reservation` (atómico): libera
  TODOS los seats y cancela la reserva.
- **Rechazo de abono posterior** → solo `payment.status='rejected'`; la reserva
  queda intacta.
- `reservations.payment_status` es **derivado** (`pending|partial|fully_paid|
  refunded|cancelled`), no fuente de verdad. Fuente de verdad: allocations.

---

## 4. Verificación / rechazo de pagos

- La verificación/rechazo es **por `payment_id` individual**, **NUNCA** por
  `reservation_id` (evita rechazar un comprobante que ya cubrió a otros).
- Tras verificar: recalcular saldos por pasajero y recalcular
  `payment_status` de la reserva (estado derivado).

---

## 5. Refunds de clientes

- Los refunds de clientes viven en **`reservation_refunds`**
  (`reason`, `amount`, `status`, `confirmed_by`).
- **`agency_ledger` SOLO registra el movimiento Nómadas ↔ Agencia.** Nunca
  registra refunds a clientes.
- Un refund de cliente no toca el ledger de agencias.

---

## 6. Deadline de comprobante (T-1)

- Regla T-1: cancelación automática de reservas marketplace sin comprobante
  verificado antes de la salida.
- Implementación: **`cancel_reservation_passenger(passenger_id)` por
  pasajero** (nunca cancela toda la reserva por un solo pasajero), libera solo
  su seat y marca `refund_required` cuando aplique.
- **Separado** del auto-complete T+3 (`completeExpiredTrips` de tour, que
  marca viajes `completed`).

---

## 7. Boarding

- El boarding sigue siendo operación de agencias (repo `nomadas-tour`).
- **Validación previa:** antes de `boarding_toggle`, exigir que el pasajero
  esté `fully_paid` (saldo 0 según allocations).
- El marketplace NO implementa scanner ni boarding.

---

## 8. Comisiones

- Trigger: viaje en `trip.completed`.
- Granularidad: **por pasajero**.
- Condiciones (todas): `source='marketplace'` + pasajero `active` +
  `fully_paid` + sin refund ni cancelación.
- **NO depende de `boarded` ni de `reservation.payment_status`** (los
  derivados pueden estar desactualizados; se usa el saldo real).
- Fee: **global** en `platform_config.marketplace_commission_fee_cents`
  (default **30** [unidades a confirmar: cents o % — asumir cents]).
- Histórico: `commissions.fee_cents` guarda el fee aplicado en su momento.
- Idempotencia: `idempotency_key` único (`trip_id + passenger_id`).

---

## 9. Primer viaje gratis

- **GRATIS para TODA la operación de la agencia en ese viaje** (todos los
  pasajeros de la agencia en ese viaje quedan `waived`).
- Atómico e idempotente por `trip_id + agency_id`.
- Distinguible: registros `first_trip_waiver` vs `commission_charge`.
- Flag de agencia: `agencies.first_marketplace_trip_completed_at`.
- NO genera comisión en ese primer viaje.

---

## 10. Fuente de reservas

- `reservations.source`: `internal` | `marketplace`.
- Las reservas `internal` pertenecen al flujo de agencias (tour) y no se
  modifican desde este repo.

---

## 11. Estados de reserva marketplace

Persistidos: `locked` → `reserved` → (`cancelled` | `completed`).
`payment_status` derivado: `pending | partial | fully_paid | refunded |
cancelled`.

---

## Fuentes de verdad

- Migraciones: `../nomadas-tour/supabase/migrations/` (historia única,
  001–080; las marketplace 074–080 están escritas y **aplicadas** —
  verificado en vivo 2026-10-06).
- Contrato con tour: [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md).
- Spec: [`system-spec.md`](system-spec.md).
