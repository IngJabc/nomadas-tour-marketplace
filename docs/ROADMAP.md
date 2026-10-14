# Nómadas Marketplace — Roadmap de producto

**Visión:** Lanzar el storefront B2C donde clientes reservan asientos de agencias conectadas, con pagos por comprobante y comisiones automáticas.
**Alcance:** Dirección de mediano plazo. No es un backlog técnico de sprint.
**Ejecución operativa:** Ver [TASKS.md](../TASKS.md).

**Última actualización:** 2026-10-14

---

## Estado actual

Fases 0, 1 y 2 completadas. El storefront B2C ya permite: autenticación de
cliente, catálogo público de viajes con mapa de asientos, wizard de reserva
con lock de asientos, y checkout con revisión de comprobante (MKT-007). La
verificación/rechazo vive en el panel de agencia de `nomadas-tour`.

| Capacidad | Estado |
| --------- | ------ |
| Bootstrap (config, app, backend, tests base, docs) | ✅ Completado |
| Auth cliente (login/register/me) | ✅ Completado |
| Catálogo público de viajes (`/viajes`, detalle + mapa de asientos) | ✅ Completado |
| Guest seats + claim | ✅ Completado |
| Wizard de reserva (asientos → pasajeros → comprobante) | ✅ Completado |
| Checkout con revisión de comprobante (MKT-007, `checkout_attempts`) | ✅ Completado |
| Panel de revisión de pagos (agencia, en repo tour, MKT-006) | ✅ Completado |
| Comisiones + primer viaje gratis | ⏳ Diseño aprobado (MKT-009) |
| Workers (T-1, comisiones, emails) | ⏳ Diseño aprobado (MKT-008…011) |
| Panel superadmin marketplace (`/admin`) | ⏳ Planificado (MKT-012) |
| Cuenta de cliente (`/cuenta`) | ⏳ Planificado (MKT-013) |
| Migraciones marketplace (074–087) | ✅ Aplicadas (074–080 verificado en vivo 2026-10-06; 085–087 posterior) |

Diseño aprobado (6 revisiones): [`business-rules.md`](business-rules.md).
Contrato con tour: [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md).

---

## Principios del producto

1. **Seguridad primero** — autorización en backend desde `public.users` + RLS.
2. **Integridad de reservas** — asientos, pagos y estados consistentes bajo
   concurrencia y expiraciones.
3. **Reusar, no reinventar** — todo patrón/RPC/migración primero se busca en
   `nomadas-tour`.
4. **Un checkout rápido** — pocas pantallas, feedback inmediato, sin sorpresas.
5. **Dinero trazable** — cada comprobante, allocation, comisión y refund es
   reconstruible; idempotencia obligatoria.
6. **Configuración sobre código** — fee, abonos y reglas en
   `platform_config`/`trips`, no hardcodeadas.

---

## Roadmap visual — secuencia

```
FASE 0 — Bootstrap                          ✅ Completada
  Repo, stack, docs, auth base, healthz

FASE 1 — Catálogo + Reserva                 ✅ Completada
  MKT-001  Migraciones 074–079 (schema marketplace)
  MKT-002  Buscador público (origen/destino/fecha)
  MKT-003  Detalle de viaje + mapa de asientos (layouts kia/bus)
  MKT-004  Wizard de reserva (locks TTL 900)

FASE 2 — Pagos                              ✅ Completada
  MKT-005  Comprobante ≤15 min + payments/payments_allocations
  MKT-006  Panel agencia (repo tour): verificar/rechazar por intento
  MKT-007  Checkout con revisión de comprobante (checkout_attempts)
           — La compra nace como intento; la reserva y el pago solo se
             crean en la aprobación atómica. Sustituye el flujo anterior
             que creaba la reserva antes de la revisión.

FASE 3 — Ciclo de vida                       ⏳ Planificada
  MKT-008  T-1 cancelación por pasajero (worker)
  MKT-009  Comisiones idempotentes + primer viaje gratis
  MKT-010  Refunds (reservation_refunds)
  MKT-011  Emails (outbox) con EMAIL_DELIVERY_MODE

FASE 4 — Panel admin + Cuenta                ⏳ Planificada
  MKT-012  /admin (sidebar) pagos, comisiones, viajes
  MKT-013  /cuenta (mis reservas, boletos, perfil)
```

---

## Fuera de alcance de este repo

- Boarding/scanner (→ `nomadas-tour`).
- Operación de agencias, digests, reminders (→ `nomadas-tour`).
- Cambio del gate `EMAIL_DELIVERY_MODE` de tour (→ coordinar).

---

## Estado de fases anteriores

No aplica — este repo inicia en Fase 0.
