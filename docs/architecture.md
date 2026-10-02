# Arquitectura General — Nómadas Marketplace

## Tipo de sistema

Storefront público B2C para buscar viajes de agencias conectadas, reservar
asientos y pagar con comprobante. Es el **compañero** de `nomadas-tour`
(plataforma B2B multi-tenant de operación).

- Este repo: catálogo + cliente + pagos + comisiones.
- `nomadas-tour`: agencias, viajes, reservas internas, boarding, operación.

---

## Arquitectura lógica

Frontend (Next.js) → Backend API (Node.js + Express) → Supabase (DB + Auth)

Misma topología y mismas versiones que `nomadas-tour` (ver
[`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md)).

---

## Identidad y seguridad

- Supabase Auth valida la sesión y entrega la identidad autenticada.
- El backend resuelve rol desde `public.users` (`customer` | `superadmin`).
- `user_metadata` NO se usa como fuente de autorización.
- RLS aplica defensa en profundidad sobre la BD compartida.
- El frontend nunca constituye una frontera de seguridad.
- Los clientes solo ven sus propias reservas (`customer_id`).

---

## Separación de dominios

### Catalog domain (público)

- Lectura de viajes activos y rutas desde la BD compartida.
- Sin PII, sin escritura.

### Booking domain (cliente)

- Lock de asientos (TTL 900s, decidido por servidor) → reserva
  `locked → reserved`.
- Pasajeros, boleto con QR, estado de pago.

### Payment domain

- `payments` (comprobante) + `payment_allocations` (reparto por pasajero).
- Verificación/rechazo por `payment_id`.
- Saldos derivados; `payment_status` derivado.

### Commission domain

- Generación al completar el viaje, por pasajero, idempotente.
- Fee global en `platform_config`; histórico en `commissions`.
- Primer viaje gratis por `trip_id + agency_id`.

---

## Capacidades transversales

### Realtime

Supabase Realtime para estados que requieren actualización inmediata
(asientos, reservas, estado de pago).

### Outbox y workers

Transactional Outbox (`outbox_events`) para side-effects asíncronos (emails de
confirmación, notificaciones). Runner de worker en
`backend/src/workers/runner.ts` (PENDING: handlers marketplace).

### Observabilidad

```text
API / Worker
  → Structured Logs (JSON stdout)
  → Metrics (in-memory) + Heartbeat
  → Sentry (opcional — SENTRY_ENABLED)
  → Worker GET /healthz (WORKER_HEALTH_PORT)
```

---

## Decisiones estructurales aprobadas

Consolidadas en [`business-rules.md`](business-rules.md) (6 revisiones):
TTL 900s, `payments + payment_allocations`, cancelación T-1 por pasajero,
comisión por pasajero sin depender de boarding, primer viaje gratis atómico,
ledger Nómadas↔Agencia separado de refunds.

---

## Fuentes de verdad

- Reglas de negocio: [`business-rules.md`](business-rules.md).
- Permisos: [`permissions.md`](permissions.md).
- Contrato con tour: [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md).
- Schema: `../supabase/migrations/` (tour) + migraciones marketplace PENDING.
