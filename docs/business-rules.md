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

## 3. Pagos — Flujo de checkout con revisión (MKT-007)

### Flujo actual (post-MKT-007)

1. **Creación del intento**: el cliente selecciona asientos, llena pasajeros
   y confirma. Se crea un `checkout_attempts` (estado `created`) que retiene
   los asientos. **NO se crea la reserva ni el pago todavía.**
2. **Subida de comprobante**: el cliente sube el comprobante con
   conciliación (referencia, banco, fecha-hora). El intento pasa a
   `pending_review`. Máximo 3 comprobantes por intento (1 + 2 reintentos).
3. **Ventana de revisión**: 24 horas por envío. Si el cliente no sube el
   comprobante a tiempo, el intento expira y los asientos se liberan.
4. **Verificación (aprobación)**: la agencia aprueba. La RPC
   `verify_checkout_attempt` crea **atómicamente** la reserva
   (`status='confirmed'`), el pago (`status='verified'`) y las allocations.
   Los asientos pasan a `reserved`.
5. **Rechazo**: la agencia rechaza con motivo. El primer y segundo rechazo
   permiten reenvío (el intento queda `rejected`); el tercer comprobante
   rechazado es definitivo (`rejected_final`) y libera los asientos que
   todavía pertenezcan al intento. Máximo 3 comprobantes por intento.
6. **Cancelación por el cliente**: el cliente puede cancelar el intento
   antes de la verificación. Los asientos se liberan.

### Reglas de negocio

- **El cliente NUNCA envía precio, estado, expiración ni `customer_id`**:
  todos los valores server-side se derivan de la sesión y la base de datos.
- **Idempotencia**: cada creación y envío exige un `Idempotency-Key` UUID.
  Un retry con la misma clave devuelve el mismo resultado (200 + `idempotent`).
- **Conciliación obligatoria**: el comprobante debe incluir
  `payment_reference`, `bank_origin` y `payment_datetime` (no futura).
- **Validación de archivo**: magic bytes, MIME consistente, máximo 5 MiB.
  La ruta en storage es `{attempt_id}/{sha256(contenido)}.{ext}` — nunca
  usa el filename del cliente.
- **Endpoints legacy desactivados**: `POST /api/public/reservations` y
  `POST /api/public/reservations/:reservationId/payments` devuelven
  `410 Gone` + `CHECKOUT_ATTEMPTS_REQUIRED`.

### Modelo de datos (post-MKT-007)

- **`checkout_attempts`**: tabla de intentos de compra. Estados:
  `created | pending_review | rejected | verified | rejected_final |
  expired | cancelled`.
- **`payments` + `payment_allocations`**: solo se crean en la verificación.
  Un comprobante cubre N pasajeros. `payment_allocations` liga
  `payment_id` con `reservation_passenger_id` y el monto asignado.
- **`seats.checkout_attempt_id`**: columna que trackea qué intento retiene
  cada asiento. Se limpia al verificar, rechazar o cancelar.
- **NO existe tabla `installments`.** El saldo se deriva:
  `saldo(pax) = seat_price − SUM(allocations verified)`.
- **Fuente del precio**: `trips.seat_price` (precio vigente) y
  `reservation_passengers.unit_price` (snapshot congelado al reservar).
  El saldo se calcula con el **snapshot**.
- Helper de solo lectura: `public.reservation_passenger_balance(pax_uuid)`.

### Estados derivados

- `reservations.payment_status` es **derivado**
  (`pending|partial|fully_paid|refunded|cancelled`), no fuente de verdad.
  Fuente de verdad: allocations.

---

## 4. Verificación / rechazo de pagos (MKT-007)

- La verificación/rechazo es **por `attempt_id` individual** en el flujo
  de checkout (MKT-007). El intento de compra se verifica o rechaza antes
  de que exista una reserva.
- Tras verificar: la RPC `verify_checkout_attempt` crea la reserva, el pago
  y las allocations en una sola transacción atómica.
- Tras rechazar: el primer y segundo rechazo permiten reenvío; el tercer
  comprobante rechazado es definitivo y libera los asientos que todavía
  pertenezcan al intento. Máximo 3 comprobantes por intento.
- **Flujo legacy (pagos ya creados)**: la verificación/rechazo es **por
  `payment_id` individual**, **NUNCA** por `reservation_id` (evita rechazar
  un comprobante que ya cubrió a otros). Tras verificar: recalcular saldos
  por pasajero y recalcular `payment_status` de la reserva (derivado).

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

**Invariante para MKT-009 (comisiones):** se excluye de comisiones todo pasajero
con `reservation_passengers.status = 'cancelled'` o con un
`reservation_refunds` en estado `required` o `completed` para su
`reservation_passenger_id`. Este invariante es válido desde MKT-008 en adelante.

**Impacto del trigger recalc (MKT-008):** dispara en CUALQUIER cancelación de pasajero
(T-1, manual agencia, MKT-013 futuro). La agencia verá `payment_status` actualizado
automáticamente en `/agency/payments`. Los refunds T-1 aparecen como
`reservation_refunds status='required'` — verificar que el panel los muestra
(MKT-010 si no).

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
