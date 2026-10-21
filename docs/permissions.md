# Permisos

## CUSTOMER (marketplace)

Rol nuevo propio de este repo. Acceso al storefront autenticado:

- Ver catálogo público de viajes (sin sesión también).
- Crear y consultar **sus propias** reservas (`reservations.customer_id`).
- Subir comprobantes de pago de **sus propias** reservas.
- Consultar estado de saldo por pasajero de sus reservas.
- Consultar el historial de **sus propias** compras (`checkout_attempts`)
  con estado derivado (RT-01).
- Ver su boleto / QR de sus reservas aprobadas (`qr_code`/`ticket_code`
  emitidos por la migración 087; RT-03, solo `reserved` + `fully_paid`).
- Gestionar su perfil (`public.users` fila propia).

No puede:

- Ver, editar ni cancelar reservas de otros clientes.
- Operar boarding (el boarding es de agencias, en `nomadas-tour`).
- Acceder a rutas admin ni agency de `nomadas-tour`.
- Modificar precios, comisiones ni configuración de viajes.

La propiedad se determina por `reservations.customer_id` (columna creada en
la migración 075 — ver `docs/NOMADAS_TOUR_INTEGRATION.md`) y, en el
historial, por `checkout_attempts.customer_id`.

## SUPERADMIN (marketplace)

Disponible en este repo para el panel admin marketplace (PENDING):

- Lectura/escritura de reservas marketplace.
- Lectura de comisiones y `platform_config`.
- La verificación/rechazo de pagos **vive en `nomadas-tour`**
  (`/agency/payments`, por `attempt_id`, MKT-006/007); los endpoints admin
  legacy de pagos de este repo responden `410 Gone`.
- Sin acceso a operación de agencias (eso vive en `nomadas-tour`).

## Roles de `nomadas-tour` (referencia — otro repo)

`SUPERADMIN` y `AGENCY` operan el panel de gestión y boarding en el repo
hermano. Este repo no los implementa ni los modifica. Ver
`../nomadas-tour/docs/permissions.md`.

## Regla clave

Toda autorización se hace EXCLUSIVAMENTE en backend.

- El frontend NUNCA es fuente de seguridad.
- La identidad se resuelve desde `public.users` tras validar Supabase Auth;
  nunca desde `user_metadata`.
- Aislamiento de cliente por `customer_id`; aislamiento comercial de agencias
  (en tour) por `agency_id`.
- RLS aplica defensa en profundidad en la BD compartida.
