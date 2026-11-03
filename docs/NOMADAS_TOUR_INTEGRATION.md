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
| GET | `/api/public/checkout/attempts` | Historial de compras del cliente (RT-01) |
| GET | `/api/public/checkout/attempts/:attemptId` | Ver estado del intento |
| GET | `/api/public/checkout/attempts/:attemptId/ticket` | Boleto QR de una compra aprobada (RT-03) |
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

## 7. RT-01…RT-03 — Historial de compras y boleto QR (2026-10-20)

El cliente autenticado ve su historial de compras y su boleto QR en
`/cuenta/compras`. Implementado **íntegramente en el marketplace**; este
repo hermano **no cambia** (escáner, RPC de abordaje y contrato QR intactos).

- **RT-01 (backend):** `GET /api/public/checkout/attempts` lista los
  intentos propios con estado derivado `buildPurchaseEstado`
  (`pendiente_comprobante` → `reserva_confirmada`, más
  `rechazado(_final)`, `aprobado`, `expirado`, `cancelado`, `desconocido`).
- **RT-02 (frontend):** `/cuenta/compras` con badges de estado, pasajeros
  en orden natural de asientos y acción "Ver boleto" solo cuando el
  backend marca `can_view_ticket` (reserva confirmada con `ticket_code`).
- **RT-03 (boleto):** `GET /api/public/checkout/attempts/:attemptId/ticket`
  devuelve `qr_code` + `ticket_code` **tal como los creó la migración 087**
  sobre `reservations` (la reserva ya existe; **nunca se regenera** un QR).
  La página `/cuenta/compras/[attemptId]/boleto` renderiza con
  `react-qr-code` (mismo componente y valor que `ReservationTicket` de
  Tour) y descarga PNG con `html-to-image`.
- **Elegibilidad:** el endpoint responde `404 TICKET_NOT_FOUND` (uniforme,
  sin filtrar estados) salvo reserva `reserved` + `fully_paid`; el frontend
  además exige `ticket_code` antes de ofrecer la acción.
- **Contrato QR:** **un solo QR por reserva** (`reservations.qr_code`);
  el escáner de Tour valida exactamente ese valor — cero cambios de
  escaneo, abordaje ni protección de duplicados.

---

## 8. REGLAS DE CONVIVENCIA

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

## 9. Env vars compartidas (advertencia BD compartida)

Ambos backends apuntan al mismo Supabase. En Render:

- `nomadas-tour` worker: flags F4/F5/WKR ya operativos (`true`).
- `nomadas-marketplace`: mantener flags en `false`/`disabled` hasta soak.
- Nunca encender `EMAIL_VIA_OUTBOX` en un servicio sin revisar el otro.

Detalle de env vars de este repo: [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md)
§ Environment.

---

## 10. PENDING — dependencias planificadas de tour (2026-10-30)

Referencia de **solo lectura** para las iniciativas del
[`ROADMAP.md`](ROADMAP.md) (LND, REV, REP, FDB, SUP, LEG). **Ninguna de estas
tareas modifica `nomadas-tour` en esta etapa**; se listan las dependencias
existentes que las nuevas iniciativas deben respetar o reutilizar.

| Iniciativa | Dependencia en tour | Tipo | Notas |
| ---------- | ------------------- | ---- | ----- |
| LND | — (endpoint `GET /api/public/trips` es de este repo) | — | El catálogo público ya filtra `status='active'`, salida futura y expone `available_seats`; no requiere cambios de tour |
| REV | `trips.status='completed'` — auto-complete T+3 (`completeExpiredTrips` de `tour/backend/src/services/trip.service.ts`, vía RPC `complete_trip` de `057_trip_events_rpc.sql`, WKR-007) + **`trips.completed_at`** (migración `097`, REV-001, SIN aplicar) | Read-only + Escritura futura | Único estado verificable de "viaje completado"; **NO** asumir completado por hora de salida pasada. `completed_at` la estampa un trigger `BEFORE UPDATE` (cubre `set_trip_status`, `complete_trip` y el UPDATE directo del worker); la ventana de 48 h se mide desde ahí |
| REV | `audit_log` (`065`, ampliado `079`/`086`/`099`) | Read-only | Trazabilidad de moderación y cambios de reseñas (`review.created`, `review.moderated`) |
| REV | Historia única de migraciones: **`097_trip_completed_at`**, **`098_review_invitations`**, **`099_trip_agency_reviews`** (+ rollbacks en `supabase/rollbacks/`) | Escritura futura (fuera de esta etapa) | Escritas en `../nomadas-tour/supabase/migrations/`, **SIN aplicar** a ninguna BD. Siguiente prefijo libre tras REV-001: **100** |
| REP / FDB / LEG | Historia única de migraciones (`../nomadas-tour/supabase/migrations/`, prefijo **100+** tras REV) | Escritura futura (fuera de esta etapa) | Tablas nuevas (`marketplace_feedback`, `legal_documents`/`legal_acceptances`, perfiles REP) se escriben en la historia única del repo tour, siguiendo la regla de una sola historia |
| REP | `agencies` + `agency_settings` (`041`) + bucket `agency-logos` (`042`) | Read-only | Datos de identidad/branding del perfil público de agencia |
| REP | `trip_agencies` (ofertas por viaje, `011`/`020`) | Read-only | Relación viaje ↔ agencia comercializadora (modelo dual) |
| SUP | `agency_contacts` (`091`, canal `call|whatsapp`) | Patrón | SUP es canal de la **plataforma**, no de agencias; no duplicar el modelo de contactos de agencia |
| FDB / SUP (futuro) | Outbox `outbox_events` + worker runner tour (`049–060`) | Read-only | Infraestructura de notificaciones si el feedback/Soporte evoluciona a notificaciones push/email |

**Regla inmutable:** todo cambio que toque tablas compartidas debe pasar por
la revisión de impacto sobre tour (§8 regla 1) antes de escribirse.

---

## 11. REV-001 — Reseñas de viaje y agencia (2026-11-01, auditoría 2026-11-02)

Implementación completa del MVP de reseñas (ROADMAP Fase 6, REV-001…006).
Backend, frontend y tests en este repo; **migraciones escritas en la historia
única de tour, SIN aplicar** a ninguna base de datos. Sin deploy, sin commit.
Tras la primera validación corrió una **ronda de auditoría independiente**
(2 subagentes read-only, marketplace y SQL) y sus correcciones; ver §11.7.

### 11.1 Migraciones (tour, `supabase/migrations/` + `supabase/rollbacks/`)

| Archivo | Contenido |
| ------- | --------- |
| `097_trip_completed_at` | Columna `trips.completed_at TIMESTAMPTZ NULL` + trigger `BEFORE UPDATE trg_trips_set_completed_at` que la estampa **solo** en la transición a `status='completed'` (cubre `set_trip_status`, `complete_trip`, `archive_trip` y el UPDATE directo del worker), la **preserva en `archived`** (estado terminal: `057 archive_trip` permite `completed → archived`; archivar jamás borra la ventana) y la limpia solo al **reabrir** (`→ active/cancelled`). **Sin backfill** de viajes históricos (fail-closed si es NULL). |
| `098_review_invitations` | `review_requests` (**UNICA por `reservation_id`** → una invitación por reserva, no dos), `customer_notifications` (notificación interna, sin email/WhatsApp) y RPC `generate_review_requests()` (SECURITY DEFINER, service_role): idempotente (`ON CONFLICT DO NOTHING`), lote `LIMIT 500`, expira pendientes vencidas; `expires_at = trips.completed_at + 48 h` **nunca** `invited_at + 48 h`. Lista inclusiva de estados: `reserved/confirmed/completed/boarded/**partial**` (excluye `locked/cancelled`); **no invita a reservas ya reseñadas** (el filtro vive en una sentencia plpgsql **separada** bajo `IF to_regclass('public.trip_reviews')` con `CONTINUE` — lazy-prepare: un sublink inline se analiza siempre y abortaría el lote con "relation trip_reviews does not exist" si 099 aún no está aplicada); los fallos por reserva se **cuentan y loguean** (`RAISE LOG` + contador `failed` en el JSONB), nunca en silencio. Permisos: `REVOKE UPDATE` total a `authenticated` en `customer_notifications` + **`GRANT UPDATE (read_at)` a nivel de columna** (el cliente solo marca leída su fila; RLS no restringe columnas). Crea también los enablers `UNIQUE(id, trip_id/…)` en `reservations` (coherencia por esquema) y el `action_url` interno `/account/reviews/{reservation_id}` (la URL **no** autoriza). |
| `099_trip_agency_reviews` | `trip_reviews` + `agency_reviews` separadas (`UNIQUE(reservation_id)` cada una, CHECK rating 1–5, comentario ≤ 2000 opcional), RPC **atómica** `submit_reservation_reviews` (valida ownership, `source='marketplace'`, reserva no `locked/cancelled`, viaje `completed` con `completed_at` presente y ventana viva; **idempotencia `already_submitted` ANTES de los chequeos de viaje/ventana** para que un reintento tardío no reciba un falso `WINDOW_EXPIRED`; lock `FOR UPDATE` + 2 inserts + invitación + 2 auditorías en UNA transacción) y RPC `moderate_review` (actor `superadmin` validado contra `public.users`, acciones `hide/reject/restore`, audita `review.moderated` en la misma transacción). `audit_log` ampliado **additivo** desde el estado VIVO de `091` (**31 acciones / 12 entidades**: guard y `ADD CONSTRAINT` incluyen `agency_payment_method.*` + `agency_contact.*` además de `review.created`/`review.moderated` y `trip_review`/`agency_review`) con guard `ERR_099_*` que exige merge manual ante migraciones posteriores. RLS: cliente lee lo suyo, público solo `visible`, escritura solo vía RPCs service_role. |

Rollbacks equivalentes en `supabase/rollbacks/097…099*_rollback.sql`:
`099` restaura los CHECK al estado vivo de **`091` (29 acciones / 10
entidades)** quitando solo los valores de 099; ejecutar en **orden inverso
`099 → 098 → 097`** (nota en el header del rollback de 098).

### 11.2 Elegibilidad (reglas de negocio)

- Solo el **cliente autenticado dueño** de la reserva
  (`reservations.customer_id`); sin reseñas por pasajero.
- Solo `reservations.source='marketplace'` (reservas internas de Tour
  excluidas del MVP).
- Estado elegible (lista inclusiva, espejo de 098/099):
  `reserved`/`confirmed`/`completed`/`boarded`/`partial`; **excluye
  `locked` y `cancelled`**. Reserva confirmada aunque luego se reembolse;
  cancelada antes del viaje NO es elegible.
- Viaje con `status='completed'` **y** `completed_at` presente; ventana
  **exactamente 48 h desde `completed_at`** (constante `REVIEW_WINDOW_HOURS`
  = 48, idéntica en SQL y TS; no es env var).
- Una reseña de viaje + una de agencia por reserva, **obligatorias ambas y
  enviadas juntas en UNA operación**. Ratings enteros 1–5; comentarios
  opcionales. El cliente **no** puede editar ni eliminar (solo corrección
  del superadmin). Visibles de inmediato salvo moderación.
- Atribución de la agencia: `reservations.agency_id`.

### 11.3 Reconciliación de invitaciones

`runReviewReconciliation()` invoca `generate_review_requests()` cada 60 s
desde el loop del backend (`backend/src/index.ts`, try/catch propio +
Sentry `REVIEW_RECONCILIATION`). Cubre todos los paths de completado,
eventos perdidos y caídas; **la generación retrasada NUNCA extiende la
ventana** (expira contra `completed_at + 48 h` en SQL). Idempotente: una
invitación por reserva.

### 11.4 API y UI

- **Backend** (`backend/src/services/review.service.ts` + rutas):
  `GET /api/public/reviews` (lista), `GET|POST /api/public/reviews/reservations/:id`
  (contexto revalidado / envío atómico), notificaciones
  `GET …/notifications` + `PATCH …/notifications/:id/read`,
  `GET /api/admin/reviews` + `PATCH /api/admin/reviews/:reviewType/:reviewId`
  (moderación, superadmin). La URL de login regresa al usuario al formulario
  exacto (`?redirect=`), pero **la URL no es token de autorización**: el
  backend revalida elegibilidad en cada GET y en el envío.
- **Frontend:** `/account/reviews` (pendiente/enviada/expirada + skeletons),
  `/account/reviews/[reservationId]` (dos estrellas 1–5 + comentarios, UNA
  acción, estados sesión/rol/404/expirado/y-enviado) y CTA "Calificar viaje
  y agencia" en `/account/purchases`.

### 11.5 Pruebas

- `backend/src/services/review.service.test.ts` (39),
  `routes/public/reviews.test.ts` + `routes/admin/reviews.test.ts` (32),
  `db/__tests__/097-099-reviews-contract.test.ts` (27). Suite backend
  completa: **429 ✅** (26 files).
- `app/account/reviews/__tests__` (17 = 7 lista + 10 formulario) + CTA de
  reseña en `app/account/purchases/__tests__` (3, dentro de sus 39). Suite
  frontend: **404 ✅** (27 files).
- Builds reales: `npm run build` raíz y en `backend/` ✅.

### 11.6 Pendiente fuera de este cambio

- Aplicar `097`–`099` en Supabase (revisión de impacto §8 regla 1 +
  rollout; siguiente prefijo libre: **100**).
- UI de moderación (panel `/admin`, MKT-012); rankings/distintivos (REP).

### 11.7 Ronda de auditoría independiente y correcciones (2026-11-02)

Dos auditorías **independientes del implementador** (subagentes `explore`
solo-lectura, mismo modelo base que el implementador — disclosure en el
reporte): una de marketplace (backend+frontend) y una de SQL (tour). Sus
hallazgos se triagearon contra el código antes de corregir; se aplicó una
única ronda de correcciones y una auditoría de verificación posterior.

Correcciones aplicadas (las de mayor severidad):

- **CRITICAL C1 (SQL)**: guards/`ADD CONSTRAINT`/`COMMENT` de `audit_log`
  en `099` reconstruidos desde el estado vivo de `091` (31 acciones / 12
  entidades); el `099` original solo contenía las 22 de `087` y **abortaría
  al aplicarse**. Rollback `099` restaura `091` (29/10).
- **HIGH H3 (SQL)**: trigger `097` ahora **preserva `completed_at` en
  `archived`** (estado terminal) y lo limpia solo al reabrir.
- **HIGH (marketplace)**: `composeReviewItem` ahora excluye de la lista las
  reservas `locked/cancelled` y los viajes `completed` sin `completed_at`
  (antes prometía un CTA "Calificar" que la RPC negaría); helper
  `isReservationStatusEligible` compartido con `getReviewContext`.
- **MEDIUM**: paginación global de `adminListReviews` con `range` +
  `slice(offset)` + guard de `.in(col, [])` + error del subquery;
  idempotencia antes de la ventana en `099` (M4); `REVOKE UPDATE` +
  `GRANT UPDATE (read_at)` en `customer_notifications` (M5); `partial` en
  la lista de `098` (M6); contador `failed` + `RAISE LOG` en `098` (M7);
  sin coerción `Number()` en ratings y docstring veraz de Idempotency-Key;
  fallback de `moderation_status` `action→status`; reset de estado al
  cambiar identidad/reserva en las páginas de reseñas; typo "otfrecer".
- **LOW**: `098` no invita a reservas ya reseñadas; comentario de deuda
  (UI de moderación) en la ruta admin.

**Ronda 2 (verificación independiente, misma sesión del auditor):** una
tercera auditoría `explore` (solo sobre las correcciones) encontró 1 HIGH
real y varios nits, corregidos a continuación:

- **HIGH D1**: el guard `to_regclass` de `098` estaba inline en el
  `SELECT ... FOR` (PostgreSQL analiza el sublink completo sin
  short-circuit → la migración abortaría sin 099). Movido a una
  sentencia plpgsql separada bajo `IF to_regclass(...) IS NOT NULL` con
  `SELECT EXISTS ... INTO` + `CONTINUE` (lazy-prepare).
- **MEDIUM D2**: `setSessionExpired(false)` al inicio de `load()` en
  ambas páginas de reseñas (reintento tras 401 no deja el panel de
  sesión visible).
- **MEDIUM D5**: tests nuevos de `adminListReviews` (merge global +
  `slice(offset)` + `has_more`, args de `range`, early-return con `.in`
  sin llamar, error del subquery → `REVIEW_ERROR`, filtro por tipo).
- **MEDIUM D9**: `contextReady` exige `context.reservation_id ===
  reservationId` (nunca pintar el formulario de otra reserva).
- **LOW D3/D4/D6/D7**: comentario obsoleto del factory de compras,
  conteo de tests verificado por ejecución (17 = 7+10), condición muerta
  del test de archivos, asserts de conteo **reales** (31/12 guards y
  ADD CONSTRAINT de 099; 29/10 del rollback).
- **D8 (preexistente, documentado sin tocar)**: el subquery de reservas
  en `adminListReviews` no pagina y el `offset` no tiene tope de
  profundidad; aceptado como deuda.

Sin variables de entorno nuevas (`REVIEW_WINDOW_HOURS=48` es constante en
SQL y TS) → **sin cambios de Render**.
