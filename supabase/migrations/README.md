# Migraciones — Nómadas Marketplace

La BD es **compartida** con `nomadas-tour`.

- Las migraciones de tour (001–073) viven en `../../nomadas-tour/supabase/migrations`.
- Las de este repo arrancan en **074** y se aplican al MISMO proyecto Supabase.

**Antes de crear cualquier migración aquí:** leer las migraciones de tour
(tablas `users`, `seats`, `reservations`, `trips`, RLS `036`/`039`,
RPCs `069`) para no romper sus CHECKs ni sus policies.

Pendientes (ver `docs/NOMADAS_TOUR_INTEGRATION.md` § PENDING):

- 074 — `customer` en `users.role_check`
- 075 — `reservations.customer_id`, `source`, `payment_status`
- 076 — `payments` + `payment_allocations`
- 077 — `platform_config`, `commissions`, `reservation_refunds`
- 078 — `trips.installment_allowed`, `trips.installment_amount_cents`
- 079 — RPC `cancel_reservation_passenger`
