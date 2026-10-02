# Permisos

## CUSTOMER (marketplace)

Rol nuevo propio de este repo. Acceso al storefront autenticado:

- Ver catálogo público de viajes (sin sesión también).
- Crear y consultar **sus propias** reservas (`reservations.customer_id`).
- Subir comprobantes de pago de **sus propias** reservas.
- Consultar estado de saldo por pasajero de sus reservas.
- Ver su boleto / QR de sus reservas.
- Gestionar su perfil (`public.users` fila propia).

No puede:

- Ver, editar ni cancelar reservas de otros clientes.
- Operar boarding (el boarding es de agencias, en `nomadas-tour`).
- Acceder a rutas admin ni agency de `nomadas-tour`.
- Modificar precios, comisiones ni configuración de viajes.

La propiedad se determina por `reservations.customer_id` (PENDING: columna a
crear — ver `docs/NOMADAS_TOUR_INTEGRATION.md`).

## SUPERADMIN (marketplace)

Disponible en este repo para el panel admin marketplace (PENDING):

- Lectura/escritura de reservas marketplace.
- Verificación/rechazo de pagos (por `payment_id`, nunca por `reservation_id`).
- Lectura de comisiones y `platform_config`.
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
