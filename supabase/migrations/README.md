# Migraciones — Nómadas Marketplace

**Este directorio es solo un puntero. No hay archivos SQL aquí.**

La BD es **compartida** con `nomadas-tour`, y por decisión de arquitectura
(2026-09-30) las migraciones viven en **una sola historia**, la del repo de
`nomadas-tour`:

- Tour: `001`–`073`
- Marketplace: `074`–`086` (las migraciones `074`–`083` son MKT-004/005; `084`–`086` son MKT-005/006)

📁 Ubicación real: `../../nomadas-tour/supabase/migrations/`

| # | Archivo | Contenido |
| - | ------- | --------- |
| 074 | `074_add_customer_role.sql` | `customer` en `users.role_check` |
| 075 | `075_reservations_marketplace.sql` | `reservations.customer_id`, `source`, `payment_status` + estados `locked`/`reserved` + policy de lectura del cliente |
| 076 | `076_payments.sql` | `trips.seat_price`, `reservation_passengers.unit_price`, `payments`, `payment_allocations`, helper de saldo |
| 077 | `077_platform_config_commissions_refunds.sql` | `platform_config`, `commissions`, `reservation_refunds`, `agencies.first_marketplace_trip_completed_at` |
| 078 | `078_trips_installments.sql` | `trips.installment_allowed`, `trips.installment_amount_cents` |
| 079 | `079_cancel_reservation_passenger.sql` | RPC `cancel_reservation_passenger` + `customer` en `audit_log` |
| 080 | `080_marketplace_guest_lock_sessions.sql` | `guest_sessions`, `seats.guest_session_id`, invariante de owner único y aislamiento por viaje · aplicada en el proyecto compartido (verificado en vivo 2026-10-06) |
| 081 | `081_create_marketplace_reservation.sql` | RPC `create_marketplace_reservation`: crea la reserva en `locked`, reserves seats, dispara `reservation.created` (source `marketplace`) |
| 082 | `082_outbox_reservation_created_scope.sql` | Emisión `reservation.created` acotada: el trigger de INSERT no emite para reservas `marketplace` en `locked`, y un trigger de UPDATE emite solo en la promoción `locked → reserved` (los flujos Tour `internal/confirmed` no cambian) |
| 083 | `083_marketplace_payment_submission.sql` | Bucket privado `payment-proofs` (5 MB, imágenes/PDF, escritura solo con `service_role`) + RPC `submit_marketplace_payment`: idempotente por namespace `mkt005:…`, inserta `payments` (`pending`, COP, monto = `SUM(unit_price)` server-side), promueve la reserva `locked → reserved` (emisión única vía 082) y pasa los seats `locked → reserved` limpiando los campos de lock |
| 084 | `084_trip_seat_price.sql` | `trips.seat_price` (precio por puesto en centavos) para el flujo Marketplace · aplicada en el proyecto compartido (verificado en staging 2026-10) |
| 085 | `085_payment_admin_actions.sql` | RPCs `verify_marketplace_payment` y `reject_marketplace_payment`: verificación (crea allocations por pasajero, `pending → verified`, `payment_status = fully_paid`, auditoría `payment.verified`) y rechazo (pago inicial → cancela la reserva `reserved` de forma atómica; abono futuro → solo rechaza y recalcula; auditoría `payment.rejected` + `reservation.cancelled`). Locks `payments → reservations → passengers → seats` (hoja `payments`, deadlock-safe) |
| 086 | `086_audit_log_payment_actions.sql` | Ampliación **aditiva** (patrón guard de 079) de los CHECK de `audit_log`: acciones `payment.verified`/`payment.rejected` y entidad `payment`. `audit_log_actor_check` no se toca |

Aplicación: en orden estricto, sobre el proyecto Supabase compartido.
Cada archivo indica su dry-run (`BEGIN; … ROLLBACK;`) en el encabezado.

Antes de tocar la BD leer [`docs/NOMADAS_TOUR_INTEGRATION.md`](../../docs/NOMADAS_TOUR_INTEGRATION.md) §5 y §6.