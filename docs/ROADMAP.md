# Nómadas Marketplace — Roadmap de producto

**Visión:** Lanzar el storefront B2C donde clientes reservan asientos de agencias conectadas, con pagos por comprobante y comisiones automáticas. Operar inicial y exclusivamente en **Venezuela**, con un modelo dual: Nómadas como agencia y Nómadas como intermediario.
**Alcance:** Dirección de mediano plazo. No es un backlog técnico de sprint.
**Ejecución operativa:** Ver [TASKS.md](../TASKS.md).

**Última actualización:** 2026-10-30

> **Nota de convención (2026-10-30):** las fases 0–4 son las épicas técnicas
> ya existentes (MKT-001…014, GUEST, RT). Las nuevas iniciativas de producto
> se agrupan en **fases 5–8** (equivalentes a las "Fase A–D" de la propuesta
> original: A→5, B→6, C→7, D→8) para no romper la numeración vigente. Cada
> iniciativa usa su **propio prefijo** (LND, REV, REP, FDB, SUP, LEG); `MKT`
> queda reservado a la épica existente de checkout/pagos/ciclo de vida para
> evitar colisiones con MKT-001…014.

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
| Catálogo público de viajes (`/trips`, detalle + mapa de asientos) | ✅ Completado |
| Guest seats + claim | ✅ Completado |
| Wizard de reserva (asientos → pasajeros → comprobante) | ✅ Completado |
| Checkout con revisión de comprobante (MKT-007, `checkout_attempts`) | ✅ Completado |
| Panel de revisión de pagos (agencia, en repo tour, MKT-006) | ✅ Completado |
| Historial de compras + boleto QR (`/account/purchases`) | ✅ Completado (RT-01…RT-03) |
| Comisiones + primer viaje gratis | ⏳ Diseño aprobado (MKT-009 — roadmap orignal) |
| Workers (T-1, comisiones, emails) | ⏳ Diseño aprobado (MKT-008…011) |
| Panel superadmin marketplace (`/admin`) | ⏳ Planificado (MKT-012) |
| Cuenta de cliente (`/account`) | ⏳ Planificado (MKT-013) |
| Migraciones marketplace (074–094) | ✅ Aplicadas (074–080 verificado en vivo 2026-10-06; 085–087 posterior; 088–094 tour) |
| **Landing dinámico (4 viajes próximos)** | ⏳ Planificado (Fase 5, **LND**) |
| **Sistema de reputación y calificaciones** | ⏳ Planificado (Fase 6, **REV/REP**) |
| **Feedback del Marketplace** | ⏳ Planificado (Fase 7, **FDB**) |
| **Atención al cliente por WhatsApp** | ⏳ Planificado (Fase 7, **SUP**) |
| **Marco legal y cumplimiento** | ⏳ Planificado (Fase 8, **LEG**) |

Diseño aprobado (6 revisiones): [`business-rules.md`](business-rules.md).
Contrato con tour: [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md).

> **Ninguna de las iniciativas LND/REV/REP/FDB/SUP/LEG está implementada.**
> Todo lo que sigue es planificación; nada debe marcarse como completado hasta
> que exista código validado y desplegado.

---

## Decisiones de negocio confirmadas (2026-10-30)

Estas decisiones dan marco a las iniciativas de este roadmap. Son
**confirmadas** por negocio; su materialización técnica es lo que cada
iniciativa detalla.

1. **Mercado geográfico: Venezuela exclusiva.**
   - El Marketplace operará inicialmente solo en Venezuela.
   - Los medios de pago y las particularidades operativas responden al mercado venezolano (ej. pago móvil, bolívares, bancos locales — ya visibles en el checkout).
   - No diseñar funcionalidades internacionales como requisito de esta etapa (multi-moneda, traducciones, impuestos extranjeros quedan fuera).

2. **Modelo dual de operación.**
   - **Nómadas como agencia:** comercializa sus propios viajes y asume las responsabilidades de esa operación.
   - **Nómadas como Marketplace intermediario:** permite que agencias externas publiquen y comercialicen sus viajes.
   - La plataforma debe distinguir quién **presta el servicio de transporte** y quién **comercializa** el viaje. No asumir que todas las reservas tienen el mismo modelo contractual.
   - La distinción afecta: información al cliente, agencia responsable, reputación, reclamos, pagos y reembolsos, términos y condiciones, acuerdos con agencias y responsabilidades operativas/legales.

3. **Reputación: dos evaluaciones independientes.**
   - El cliente califica por separado **el viaje realizado** y **la agencia responsable del viaje**.
   - Las calificaciones se vinculan a **reservas verificadas** y **viajes completados**.

4. **Atención al cliente por WhatsApp.**
   - Canal de atención directa mediante WhatsApp.

5. **Documentación legal adaptada a Venezuela.**
   - Conjunto de documentos legales del modelo de operación, con **revisión jurídica antes de su publicación**.
   - El roadmap no presenta documentos generados automáticamente como asesoramiento jurídico definitivo.

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
7. **Confianza ganada, no declarada** — la reputación, los distintivos y los
   promedios se muestran solo con datos verificables y volumen suficiente;
   nunca inventar puntuaciones ni rankings sin evidencia.
8. **Cumplimiento legal como requisito, no como afterthought** — los
   documentos legales y el registro de aceptación son parte del producto.

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

FASE 4 — Panel admin + Cuenta                ⏳ Planificada (parcial ✅)
  MKT-012  /admin (sidebar) pagos, comisiones, viajes
  MKT-013  /account (mis reservas, boletos, perfil)
           — ✅ 2026-10-20: historial de compras + boleto QR
             (/account/purchases, RT-01…RT-03); perfil y mis reservas
             siguen pendientes

FASE 5 — Experiencia pública                 ⏳ Planificada (2026-10-30)
  LND-001  Landing dinámico: 4 viajes próximos desde endpoint público
  LND-002  Estados de carga, error y ausencia de viajes + CTA catálogo
  LND-003  Tarjetas preparadas para imagen/descripción futuros

FASE 6 — Confianza y reputación              ⏳ Planificada (2026-10-30)
  REV-001  Definición de "viaje completado" elegible (estado verificable)
  REV-002  Diseño de datos de calificaciones (viaje y agencia, independientes)
  REV-003  MVP de evaluación: estrellas 1–5 + comentario opcional
  REV-004  Reglas de integridad y moderación (backend + DB)
  REP-001  Perfil público de agencia
  REP-002  Ranking de confiabilidad (algoritmo: decisión pendiente)

FASE 7 — Atención y mejora continua          ⏳ Planificada (2026-10-30)
  FDB-001  Canal privado de feedback del Marketplace (modelo + estados)
  FDB-002  Interface administrativa de revisión de feedback
  SUP-001  Apartado de ayuda + acceso visible a WhatsApp
  SUP-002  Botón flotante de WhatsApp con mensajes predefinidos

FASE 8 — Marco legal                        ⏳ Planificada (2026-10-30)
  LEG-001  Documentos legales (modelo dual, Venezuela)
  LEG-002  Mecanismo de aceptación con versionado y trazabilidad
  LEG-003  Política de privacidad y cookies
  LEG-004  Revisión jurídica externa antes de publicar
```

### Relación de fases con la propuesta original (A–D)

| Propuesta original | Fase del roadmap | Contenido |
| ------------------ | ---------------- | --------- |
| Fase A — Experiencia pública | **Fase 5** | Landing dinámico (LND) |
| Fase B — Confianza y reputación | **Fase 6** | Reputación (REV/REP) |
| Fase C — Atención y mejora continua | **Fase 7** | Feedback + WhatsApp (FDB/SUP) |
| Fase D — Marco legal | **Fase 8** | Documentos + aceptación (LEG) |

El orden A→D (5→6→7→8) se mantiene tras revisar dependencias: la Fase 5 es
independiente y de menor riesgo; la Fase 6 requiere decidir el estado de viaje
completado antes de exponer ratings; la Fase 7 no depende de las anteriores
pero conviene llegar después de tener la operación de confianza; la Fase 8
cierra con los marcos legales que deben acompañar la publicación de
reputación y atención. La única salvedad es que el trabajo legal (iniciativa
LEG) debe **iniciarse en paralelo temprano** por su dependencia de revisión
humana externa (ver § Dependencias).

---

## Fuera de alcance de este repo

- Boarding/scanner (→ `nomadas-tour`).
- Operación de agencias, digests, reminders (→ `nomadas-tour`).
- Cambio del gate `EMAIL_DELIVERY_MODE` de tour (→ coordinar).
- Funcionalidades internacionales (multi-moneda, i18n completo) — decisión 2026-10-30.

---

## Estado de fases anteriores

No aplica — este repo inicia en Fase 0.

---
---

# Iniciativas de producto (2026-10-30)

Cada iniciativa sigue el formato: identificador, objetivo, problema, alcance
MVP, fuera de alcance, dependencias, riesgos, criterios de aceptación, tareas,
pruebas, estado y decisiones pendientes. **Ninguna está implementada.**

Leyenda de tipos de decisión:
- **[CONFIRMADA]** — decisión de negocio ya tomada.
- **[PROPUESTA]** — propuesta técnica/de diseño, puede ajustarse.
- **[PENDIENTE]** — decisión que debe resolverse antes o durante la fase.
- **[LEGAL]** — requisito sujeto a revisión jurídica externa.

---

## LND — Landing dinámico (Fase 5)

**Objetivo:** Mostrar en el home del Marketplace los cuatro viajes más
próximos con disponibilidad, obtenidos desde datos reales.

**Problema que resuelve:** La landing actual usa contenido estático/hardcodeado
y no refleja la oferta real de viajes. El cliente no ve salidas concretas sin
ir al catálogo.

**Alcance MVP:**
- Sección en el home que muestra **únicamente 4 viajes**.
- Ordenados por **fecha y hora de salida ascendente**.
- Solo viajes **activos, futuros y con disponibilidad de puestos**.
- Datos desde el **endpoint público existente** (`GET /api/public/trips`).
- Sin viajes hardcodeados; sin información ficticia si no hay resultados.
- Tarjeta: origen, destino, fecha/hora, precio por puesto, disponibilidad si el endpoint la expone.
- Estados de carga (skeleton), error (con reintento) y ausencia de viajes (empty state con CTA).
- Enlace "Explorar todos los viajes" → `/trips`.

**Fuera de alcance MVP:**
- Sistema de gestión de imágenes o descripciones (no ampliar el alcance).
- Campos nuevos en el endpoint público (salvo que sea imprescindible).
- Páginas de detalle nuevas.

**Dependencias:**
- `GET /api/public/trips` (ya implementado y con disponibilidad por viaje).
- Design tokens y componentes existentes (`TarjetaViaje` de `/trips` es reutilizable como referencia).

**Riesgos:**
- Overfetch del endpoint (limit 100) si se quisiera orden distinto al del backend.
- Diseño de tarjeta que no deje slot claro para imagen/descripción futuros.

**Criterios de aceptación:**
- Home muestra exactamente 0..4 tarjetas; nunca inventa datos.
- Orden garantizado por `departure_time` ascendente.
- Skeleton en carga; empty state con CTA si 0 resultados; toast/estado en error.
- Tarjeta preparada con slot para imagen/descripción (puede quedar vacío).
- CTA de catálogo visible.
- Tests de frontend para render, estados vacío/error y orden.

**Tareas de implementación:**
- **LND-001** — Sección "Viajes próximos" en `app/page.tsx` (componente nuevo).
- **LND-002** — Fetch a `publicApi.trips()`, slice a 4, transformación de datos.
- **LND-003** — Componentes de tarjeta con slots futuros (imagen/descripción).
- **LND-004** — Skeleton + empty state + estado de error.
- **LND-005** — Enlace a `/trips`.
- **LND-006** — Tests (render, orden, vacío, error).

**Pruebas necesarias:**
- Unitarias del componente (mock de `publicApi.trips`).
- Integración: home carga sección, ordena, recorta a 4, maneja 0 viajes.

**Estado actual:** ⏳ Planificado (no implementado).

**Decisiones pendientes:**
- [PENDIENTE] Diseño exacto de la tarjeta y jerarquía de campos.
- [PENDIENTE] ¿La sección aparece siempre o solo si hay ≥1 viaje?

---

## REV — Sistema de reputación y calificaciones (Fase 6)

**Objetivo:** Permitir que clientes autenticados con reservas verificadas
evalúen **el viaje** y **la agencia** por separado, con reglas de integridad
robustas.

**Problema que resuelve:** No hay forma de medir la calidad percibida del
servicio ni de generar confianza entre clientes y agencias.

### 3.1 Calificación del viaje (MVP)
- Puntuación 1–5 estrellas.
- Comentario opcional.
- Fecha de evaluación.
- Reserva asociada.
- Usuario que evalúa.
- Estado de moderación (si aplica).

### 3.2 Calificación de la agencia (MVP)
- Puntuación 1–5 estrellas.
- Comentario opcional.
- Reserva asociada.
- Agencia evaluada.
- Usuario evaluador.
- Evaluaciones de viaje y agencia **independientes**.

### 3.3 Reglas de integridad (planificar, validar en backend + DB)
- Solo usuarios autenticados.
- Solo clientes con **reserva verificada** (flujo `checkout_attempts` → `verified`).
- Solo **viajes completados** (estado verificable, no asumir por hora pasada).
- Una evaluación por usuario, reserva y entidad evaluada.
- Sin autoevaluaciones de agencia.
- Sin duplicados (constraint único en DB).
- Protección contra manipulación de puntuaciones.
- Reporte de comentarios inapropiados.
- Moderación administrativa.
- Registro de cambios relevantes (`audit_log`).

### 3.4 Ranking de confiabilidad (ver también REP)
- Considerar: promedio, número de evaluaciones, antigüedad/recencia, viajes completados.
- Mínimo de evaluaciones para distintivos.
- No ordenar solo por promedio de estrellas.
- Algoritmo exacto: **decisión de diseño pendiente** (alternativas en REP).

### 3.5 Perfil público de agencia (ver también REP)
- Identidad, promedio, cantidad de evaluaciones, comentarios, indicadores de confiabilidad, viajes disponibles.
- Distinguir reputación de Nómadas como agencia vs reputación del Marketplace.

**Fuera de alcance MVP:**
- Criterios secundarios (puntualidad, comodidad, etc.).
- Respuesta pública de agencias a reseñas.
- Gamificación o incentivos por reseñas.

**Dependencias:**
- Definición clara del estado **"viaje completado"** (Fase 6, REV-001).
- Relación reservas ↔ viajes ↔ agencias (`reservations`, `trip_agencies`, `agencies`).
- `checkout_attempts` verificados.
- Tabla `audit_log` para moderación.
- Migraciones en `../nomadas-tour/supabase/migrations/` (historia única).

**Riesgos:**
- Reputación manipulable si las reglas no se validan en DB.
- Exponer ratings sin "viaje completado" verificable rompe la regla 11 AGENTS (no limpiar hasta confirmación) y la decisión de negocio.
- Mostrar ranking sin datos suficientes (violación de principio 7).

**Criterios de aceptación:**
- Cliente con reserva `verified` y viaje `completed` puede evaluar viaje y agencia independientemente.
- Segunda evaluación del mismo par (usuario, reserva, entidad) es bloqueada por constraint.
- Autoevaluación de agencia bloqueada.
- Moderación posible por superadmin; cambios auditados.
- Sin datos suficientes, no se muestran rankings ni distintivos.

**Tareas de implementación:**
- **REV-001** — Definir e implementar flag/estado de "viaje completado" elegible (decidir con negocio).
- **REV-002** — Diseñar esquema: `trip_reviews`, `agency_reviews` con constraints únicos.
- **REV-003** — Endpoints backend: crear leer/moderar reseñas; rate limiting.
- **REV-004** — Reglas de integridad en DB (constraints, triggers) + `audit_log`.
- **REV-005** — UI de evaluación (estrellas, comentario) en flujo post-viaje.
- **REV-006** — Panel de moderación superadmin (básico).

**Pruebas necesarias:**
- Backend: unicidad, autoría, estado del viaje, rate limit, autoevaluación.
- Frontend: formulario, bloqueo de doble envío, feedback de éxito/error.

**Estado actual:** ⏳ Planificado.

**Decisiones pendientes:**
- [PENDIENTE] Definición exacta de "viaje completado" (campo/estado/lógica).
- [PENDIENTE] Ventana de tiempo para evaluar tras completar.
- [PENDIENTE] Algoritmo de ranking (alternativas en REP).
- [PENDIENTE] Política de moderación (términos, umbrales de ocultado).

---

## REP — Ranking y perfiles de reputación (Fase 6)

**Objetivo:** Presentar al cliente indicadores de confiabilidad de agencias y
un perfil público, sin mostrar rankings engañosos.

**Problema que resuelve:** El cliente necesita comparar agencias con criterios
sólidos (no solo estrellas aisladas) y ver quién presta el servicio.

**Alcance MVP:**
- Ranking de confiabilidad con: promedio, volumen, recencia, viajes completados.
- Mínimo de evaluaciones para mostrar distintivos.
- Perfil público de agencia: identidad, promedio, cantidad, comentarios, indicadores y viajes disponibles.
- Distinguir Nómadas como agencia vs Marketplace.

**Fuera de alcance:**
- Algoritmos de ML.
- Sistema de certificación externo.

**Dependencias:**
- Iniciativa REV (datos de reseñas y volumen).
- Modelo de agencias (`agencies`, `trip_agencies`).

**Riesgos:**
- Mostrar una agencia con 1 reseña de 5★ por encima de una con cientos (violación explícita del requerimiento).

**Criterios de aceptación:**
- No se ordena exclusivamente por promedio.
- Distintivos solo con mínimo de evaluaciones alcanzado.
- Perfil público muestra la distinción Nómadas-agencia vs Marketplace.
- Sin datos suficientes, el perfil/estado queda oculto o marcado como "insuficiente".

**Tareas:**
- **REP-001** — Diseñar algoritmo de confiabilidad (documentar alternativas).
- **REP-002** — Endpoint de ranking + perfil de agencia.
- **REP-003** — UI de ranking y perfil público.

**Pruebas:**
- Casos borde: 0 reseñas, 1 reseña 5★ vs 100 reseñas 4.8★, antigüedad.

**Estado actual:** ⏳ Planificado.

**Decisiones pendientes:**
- [PENDIENTE] **Algoritmo exacto** — se deben documentar alternativas (p. ej.:
  a) media simple con mínimo N; b) media ponderada por recencia
  (decaimiento temporal); c) score bayesiano / lower confidence bound que
  penaliza volumen bajo; d) combinación: nota bayesiana + bonus por viajes
  completados + distintivo "top" solo con N≥X). Comparación de pros/contras
  requerida antes de implementar.
- [PENDIENTE] Valor del mínimo de evaluaciones para distintivos.
- [PENDIENTE] Dónde vive el perfil público (ruta pública vs panel).

---

## FDB — Feedback del Marketplace (Fase 7)

**Objetivo:** Canal privado para recibir comentarios y sugerencias sobre la
propia plataforma.

**Problema que resuelve:** No hay un canal estructurado para que clientes
reporten problemas o sugieran mejoras sin confundirlo con reseñas públicas.

**Alcance MVP:**
- Categorías iniciales: problemas con reservas, pagos, técnicos, experiencia de usuario, sugerencias, otros.
- Datos: usuario (si autenticado), categoría, mensaje, fecha, estado, respuesta administrativa (si se implementa).
- Estados: `new`, `in_review`, `resolved`, `closed`.
- Interface administrativa futura para revisión.

**Fuera de alcance:**
- Confundir con reseñas públicas de viajes/agencias.
- Sistema de tickets completo con SLA (evolución futura, ver SUP).

**Dependencias:**
- Auth de cliente (opcional pero recomendado para trazabilidad).
- Nuevo modelo/tabla de feedback.
- Panel admin (MKT-012) para la interface administrativa.

**Riesgos:**
- Duplicidad conceptual con SUP o con REV si no se delimita bien.

**Criterios de aceptación:**
- Cliente puede enviar feedback con categoría y mensaje.
- Feedback privado (no público).
- Estados gestionables por superadmin.
- Feedback no aparece como reseña pública.

**Tareas:**
- **FDB-001** — Modelo `marketplace_feedback` (migración en repo tour).
- **FDB-002** — Endpoint de creación/listado.
- **FDB-003** — UI de envío (modal o página).
- **FDB-004** — UI superadmin de revisión (básica).

**Pruebas:** backend (creación, estados), frontend (formulario, validación).

**Estado actual:** ⏳ Planificado.

**Decisiones pendientes:**
- [PENDIENTE] ¿Requiere autenticación o también guests?
- [PENDIENTE] Integración con panel admin existente vs nueva vista.

---

## SUP — Atención al cliente por WhatsApp (Fase 7)

**Objetivo:** Ofrecer un canal de atención directa por WhatsApp y un apartado
de ayuda.

**Problema que resolve:** El cliente no tiene un canal inmediato de contacto
para dudas o incidencias.

**Alcance MVP:**
- Botón flotante de WhatsApp.
- Página/sección de ayuda.
- Número de contacto configurable.
- Mensajes predefinidos según consulta: general, reserva, pago, reporte de agencia, sugerencia.
- Con reserva relacionada: generar mensaje con su identificador.
- Nunca incluir contraseñas, tokens, documentos personales ni datos de pago sensibles.

**Fuera de alcance MVP:**
- Sistema de tickets (identificador, estado, historial, responsable, tiempo de respuesta, seguimiento) — evolución futura.

**Dependencias:**
- `platform_config` o env var para número configurable.
- Componente de botón flotante (portal/global).

**Riesgos:**
- Convertir el MVP en sistema de soporte complejo.
- Fugas de datos sensibles en mensajes predefinidos.

**Criterios de aceptación:**
- Botón visible en todas las páginas públicas/auth.
- Click abre WhatsApp con mensaje predefinido correcto.
- Si hay contexto de reserva, el mensaje incluye su identificador.
- Número configurable sin redeploy (config) o con env var clara.
- No se incluyen datos sensibles en el mensaje.

**Tareas:**
- **SUP-001** — Configuración del número (platform_config/env).
- **SUP-002** — Componente botón flotante WhatsApp.
- **SUP-003** — Plantillas de mensajes por categoría.
- **SUP-004** — Página de ayuda con categorías.

**Pruebas:** apertura de wa.me con payload correcto, contextos con/sin reserva.

**Estado actual:** ⏳ Planificado.

**Decisiones pendientes:**
- [PENDIENTE] Número: env var o `platform_config`.
- [PENDIENTE] ¿Mensajes en español, inglés o ambos? (Venezuela → español por defecto, [CONFIRMADA] mercado VE).

---

## LEG — Marco legal y cumplimiento (Fase 8)

**Objetivo:** Crear el conjunto de documentos legales y el mecanismo de
aceptación con trazabilidad, adaptados al modelo dual y a Venezuela.

**Problema que resuelve:** Sin estos documentos el producto no puede operar
con validez legal ni registrar consentimientos.

**Alcance MVP — documentos:**
1. Términos y condiciones del Marketplace.
2. Política de privacidad.
3. Política de cookies.
4. Política de pagos y reembolsos.
5. Política de cancelaciones.
6. Acuerdo de participación y comercialización para agencias.
7. Política de reseñas y moderación de contenido.

**Modelo dual en los documentos [CONFIRMADA]:**
- Nómadas como agencia: identificación como comercializador/responsable contractual, condiciones, obligaciones de agencia y prestador si son distintos, reclamos y reembolsos.
- Nómadas como intermediario: identificación de la agencia ofertante, alcance de la intermediación, responsabilidades de cada participante, pagos/comprobantes, reclamos y disputas.
- No redactar cláusulas que pretendan eliminar responsabilidades legales que correspondan por ley [LEGAL].

**Privacidad y cookies [LEGAL]:** datos recopilados, finalidades, base y
mecanismos de tratamiento, conservación, derechos, seguridad, cookies,
consentimiento cuando corresponda.

**Aceptación y trazabilidad:**
- Registrar aceptación de términos.
- Registrar versión del documento.
- Registrar fecha y usuario.
- Solicitar nueva aceptación cuando cambien documentos que lo requieran.
- Mantener trazabilidad.
- No implementar con simple checkbox sin persistencia y versionado.

**Fuera de alcance MVP:**
- Redacción final y publicación (requiere revisión jurídica).
- Implementar flujos de bloqueo por no aceptación (puede ser fase posterior).

**Dependencias:**
- Revisión jurídica externa (recurso humano externo, planificar con antelación).
- Modelo de usuarios y reservas para trazabilidad.
- Migraciones para `legal_documents` y `legal_acceptances`.

**Riesgos:**
- Publicar sin revisión jurídica (riesgo regulatorio).
- Aceptaciones sin versionado → no trazables.

**Criterios de aceptación:**
- Sistema de aceptación con versión + fecha + usuario persistidos.
- Cambio de documento que lo requiera dispara re-aceptación.
- Documentos diferencian el modelo dual.
- Revisión jurídica externa completada antes de publicar.

**Tareas:**
- **LEG-001** — Definir modelo `legal_documents` + `legal_acceptances` (migración en repo tour).
- **LEG-002** — Backend: endpoints de aceptación y consulta de versión vigente.
- **LEG-003** — Frontend: flujo de aceptación en registro y login.
- **LEG-004** — Redacción inicial de borradores (con revisión jurídica externa posterior).
- **LEG-005** — Panel superadmin para gestionar versiones (básico).

**Pruebas:** persistencia de aceptación, re-aceptación tras cambio de versión, trazabilidad.

**Estado actual:** ⏳ Planificado.

**Decisiones pendientes:**
- [LEGAL] Proveedor/abogado para revisión.
- [PENDIENTE] Momento de la aceptación (solo registro vs también en checkout).
- [PENDIENTE] Alcance del bloqueo por no aceptación (¿obligatorio operar?).

---
---

# Dependencias entre iniciativas

| Iniciativa | Depende de | Bloqueada por |
| ---------- | ---------- | ------------- |
| LND | Endpoint público existente | Nada (inmediato) |
| REV | Definición de "viaje completado" | REV-001 |
| REP | REV (datos de reseñas + volumen) | REV completado al menos parcialmente |
| FDB | Auth cliente, panel admin futuro | MKT-012 (para interface admin completa) |
| SUP | `platform_config` para número | Nada crítico |
| LEG | Revisión jurídica externa | Recurso humano externo |

Secuencia recomendada: **LND → REV → REP → FDB/SUP (paralelizables) → LEG**.
LEG debe iniciar su actividad de revisión jurídica en paralelo temprano por
su dependencia de recursos externos.

---

# Decisiones pendientes consolidadas

1. Algoritmo exacto de ranking de confiabilidad (REP) — con alternativas documentadas.
2. Definición de "viaje completado" elegible para reseñas (REV).
3. Mínimo de evaluaciones para distintivos de confiabilidad.
4. Número de WhatsApp: `platform_config` vs env var (SUP).
5. Borradores legales iniciales y proveedor de revisión jurídica (LEG).
6. Momento y bloqueo de la aceptación legal (LEG).
7. Si el feedback requiere autenticación (FDB).

---

# Inconsistencias detectadas con el roadmap anterior

1. **Naming drift preexistente (ya documentado en TASKS):** MKT-010 fue
   ejecutado como "expiración integral del checkout"; el roadmap original lo
   reservaba para refunds. Además, comentarios de código usan "MKT-008" para
   contactos de agencia y "MKT-007.4" para payment-methods, que no corresponden
   a las tareas de la serie original. **Resolución:** se mantiene el drift
   histórico y se usan prefijos nuevos dedicados (LND, REV, REP, FDB, SUP,
   LEG) para evitar más colisiones.

2. **Propuesta original usaba "MKT" para landing dinámico:** colisionaría con
   la épica MKT-001…014. **Resolución:** se usa **LND** (Landing).

3. **Fases originales A–D:** se renumeraron a 5–8 para continuar la secuencia
   existente (0–4) sin ambigüedad.

4. **"Confirmación inmediata" en el hero de la landing actual** contradice el
   flujo real con revisión de comprobante (24h de ventana). No es un bug de
   código pero es copy inconsistente con MKT-007. **Resolución:** anotado como
   pendiente de copy (no forma parte de LND-MVP pero debe corregirse).

5. **`NOMADAS_TOUR_INTEGRATION.md` referenciaba "§ PENDING" en múltiples
   docs pero la sección no existía.** **Resolución:** se añade §10 PENDING
   con las dependencias planificadas de tour para las nuevas iniciativas.

6. **`PROJECT_CONTEXT.md` y `system-spec.md` quedaron desactualizados** en
   algunas tablas (endpoints, estado de fases). **Resolución parcial:**
   PROJECT_CONTEXT se actualiza con filas de nuevas iniciativas; system-spec
   queda como referencia histórica y debe actualizarse al iniciar cada fase.
