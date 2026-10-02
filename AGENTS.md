> Este archivo es de lectura obligatoria antes de comenzar cualquier tarea.
> Contiene las reglas del proyecto. No las ignores, no las inventes.
>
> **Proyecto:** `nomadas-marketplace` — storefront público de reservas.
> Compañero operativo de `nomadas-tour` (admin/agency/boarding). Este repo NO
> implementa boarding, ni operación de agencias. Ver `docs/NOMADAS_TOUR_INTEGRATION.md`.

---

## 🎨 Design Tokens — Single Source of Truth

### Colores (usar SIEMPRE estas variables, nunca valores hardcodeados)

```css
--color-brand-cyan:       #00D4FF   /* Acento principal, CTAs, highlights */
--color-brand-blue:       #0080FF   /* Acento secundario, hovers */
--color-brand-navy:       #000024   /* Fondo principal, navbar, sidebar */
--color-brand-dark:       #00000C   /* Fondo más oscuro, hero sections */
--color-brand-mid:        #0a0a2e   /* Fondos intermedios (derivado de marca) */
--color-brand-surface:    #fdfdfd   /* Tarjetas y formularios */
--color-brand-muted:      #6b7280   /* Textos secundarios */
```

### Colores semánticos (no cambiar)

Success: #10b981

Warning: #f59e0b

Danger: #ef4444

Info: #00D4FF (mismo que cyan)

Page bg: #f1f5f9

### Tipografía

- **Headings (h1–h3, títulos de sección):** Montserrat, peso 700–800
- **Body, labels, botones, links:** Poppins, peso 400/600
- **Nunca usar:** Geist, Inter, u otras fuentes no listadas aquí

### Escala tipográfica

Título página: Montserrat 800 / 28px

Título sección: Montserrat 700 / 20–24px

Título tarjeta: Poppins 600 / 17–18px

Body normal: Poppins 400 / 14px

Label/caption: Poppins 400 / 12–13px

Badge/tag: Poppins 600 / 11–12px

---

## 💭 Filosofía de Diseño

Nomadas Tour no es un panel administrativo.

Debe sentirse como un centro de operaciones.

Cada pantalla debe responder inmediatamente:

- Qué está pasando
- Qué necesita atención
- Qué acción debo realizar

La jerarquía visual siempre será:

1. Estado actual
2. Acción principal
3. Información relevante
4. Información secundaria
5. Historial

Nunca diseñar pantallas únicamente para mostrar datos.

Cada pantalla debe invitar a realizar una acción.

---

## 🏗️ Layout General

Todo dashboard debe dividirse en cuatro zonas:

1. **Header contextual**

   Ejemplo:
   Buenos días, Agencia Central.
   Hoy tienes: 18 pasajeros pendientes, 3 viajes activos.

2. **Quick Actions**

   Cards grandes con acciones.
   Ejemplo: Nueva reserva, Escanear QR, Ver pasajeros.

3. **Información viva**

   Cards que muestran datos en tiempo real.
   Ejemplo: Viaje actual, Pasajeros, Abordados, Pendientes, Hora de salida.

4. **Actividad reciente**

   Timeline vertical.
   Evitar tablas cuando sea posible.

---

## 📐 Sistema de Espaciado

Usar exclusivamente múltiplos de 8px.

Escala oficial:

8 — 16 — 24 — 32 — 40 — 48 — 64

Nunca usar márgenes arbitrarios.

Priorizar espacios amplios.

---

## 🔲 Grid

Usar grid adaptable.

Desktop: 12 columnas.

Tablet: 8 columnas.

Mobile: 4 columnas.

Todo dashboard debe tener:

```
max-width: 1600px
margin: auto
padding: 32px
```

Nunca expandir el contenido al ancho completo del monitor.

---

## 🔤 Tipografía — Reglas complementarias

Mantener Montserrat y Poppins como las únicas fuentes del sistema.

Nunca escribir bloques largos con el mismo peso tipográfico.

Alternar:

- títulos
- subtítulos
- números
- badges
- captions

Los números importantes deben tener mayor jerarquía que el texto que los describe.

---

## 🧩 Componentes — Reglas de estilo

### Botón Primario (CTA principal)

fondo: --color-brand-cyan

hover: --color-brand-blue

texto: blanco, Poppins 600 14–15px

border-radius: 10px

padding: 10px 20px (normal) / 14px 24px (grande)

transición: background 200ms ease

disabled: opacity 0.4, cursor not-allowed

### Botón Secundario

fondo: #f1f5f9

texto: --color-brand-navy, Poppins 600 14px

border-radius: 10px

hover: fondo #e2e8f0

### Botón Destructivo (Eliminar)

fondo: #fef2f2

texto: #ef4444, Poppins 600 12–14px

border-radius: 8–10px

hover: fondo #fee2e2

SIEMPRE requiere modal de confirmación antes de ejecutar la acción

### Inputs / Campos de formulario

border: 1.5px solid #e5e7eb

border-radius: 10px

padding: 12px 16px

font: Poppins 400 14px

focus: border-color --color-brand-cyan

box-shadow 0 0 0 3px rgba(0,212,255,0.15)

SIEMPRE incluir label visible encima del campo (no solo placeholder)

Label style: Poppins 500 12px, --color-brand-muted, uppercase

### Tarjetas (Cards)

fondo: --color-brand-surface

border-radius: 16px

border: 1px solid rgba(0,0,0,0.06)

box-shadow: 0 1px 3px rgba(0,0,0,0.06)

padding: 24px

Cada card debe contener: título, dato principal, contexto y acción.

Evitar cards únicamente informativas.

hover: box-shadow 0 6px 24px rgba(0,212,255,0.12)

translateY(-2px), transición 200ms

El color cyan se reserva para acciones, foco, indicadores, gráficos y estados activos — no para bordes decorativos de cards.

### Títulos de sección

Siempre con barra izquierda de 4px en --color-brand-cyan

Implementar con border-left o pseudo-elemento ::before

padding-left: 12px

### Badges / Pills de estado

Activo/Disponible: fondo #ecfdf5, texto #059669

Inactivo/Reservado: fondo #f1f5f9, texto --color-brand-muted

Cancelado: fondo #fef2f2, texto #ef4444

Advertencia: fondo #fffbeb, texto #92400e

border-radius: 9999px (siempre pill)

padding: 3px 10px

font: Poppins 600 11px

---

## 📊 Dashboard

No diseñar dashboards tipo CRUD.

Cada dashboard debe priorizar:

- estado del negocio
- acciones rápidas
- métricas
- actividad reciente

Usar: Cards, Widgets, Timeline, Master-detail.

Evitar tablas grandes.

---

## 📈 KPI Cards

Toda KPI Card debe incluir:

- icono
- valor principal
- contexto
- tendencia
- acción

Ejemplo:

```
Pasajeros
126
+8 hoy
Ver lista →
```

---

## 📋 Tablas

Las tablas son el último recurso.

Preferir: Cards, Listas, Timeline, Accordion, Master-detail.

Solo usar tablas cuando existan grandes cantidades de registros.

---

## 🗺️ Estructura de pantallas

### Entrada y autenticación (cliente)

- `/` → Landing pública (hero + pasos + CTAs)
- `/login` → Login de cliente
- `/register` → Registro de cliente
- `/forgot-password` → Solicitud de recuperación (PENDING)
- `/reset-password` → Restablecimiento de contraseña (PENDING)

### Catálogo público

- `/viajes` → Buscador de viajes (origen, destino, fecha)
- `/viajes/[id]` → Detalle del viaje + mapa de asientos (PENDING)
- `/agencias` → Agencias conectadas (PENDING)

### Reserva (cliente autenticado)

- `/reservas/nueva` → Wizard de reserva: asientos → pasajeros → pago (PENDING)
- `/reservas/[id]` → Detalle de reserva + estado de pago + boleto (PENDING)
- `/cuenta` → Mi cuenta / perfil (PENDING)

### Área admin marketplace (PENDING IMPLEMENTATION)

- `/admin` → Panel con sidebar navy izquierdo
- `/admin/viajes`, `/admin/pagos`, `/admin/comisiones`, `/admin/agencias`
- El admin SIEMPRE tiene sidebar, nunca navbar horizontal

### Navbar global

fondo: --color-brand-navy

altura: 64px

sticky: top-0, z-index alto

logo: izquierda

nav links: Poppins 400 14px, blanco opacity 0.75, hover opacity 1

CTA btn: --color-brand-cyan, pill (border-radius 9999px)

---

## 🚫 Estados Vacíos

Todo Empty State debe incluir:

- ilustración o iconografía
- explicación breve
- CTA principal

Nunca mostrar una pantalla vacía sin acción.

---

## ⏳ Loading

Nunca usar únicamente un spinner centrado.

Usar Skeletons: Cards placeholder, Listas placeholder, Charts placeholder.

---

## 🎬 Motion

Mantener Framer Motion.

Duración estándar: 150–250ms.

Animar únicamente:

- hover
- open / close
- success / error
- expand / collapse

Las animaciones nunca deben bloquear la interacción del usuario.

---

## 📢 Feedback

Nunca usar `alert()`.

Usar Toast.

Tipos: Success — Info — Warning — Error

Duración estándar: 2500ms

Acciones destructivas: SIEMPRE modal de confirmación antes de ejecutar.

---

## 📷 Scanner QR

> **Nota:** el scanner de boarding pertenece a `nomadas-tour` (operación de
> agencias). Este repo NO implementa boarding. Se conserva aquí como referencia
> de estilo por si se comparten componentes.

El scanner debe ser la pantalla más rápida del sistema.

Objetivos:

- operación con una mano
- mínima cantidad de clicks
- feedback inmediato

Después de un abordaje exitoso:

- animación de éxito
- toast
- volver automáticamente al estado de escaneo

Nunca mostrar nombres individuales de pasajeros.

Mostrar únicamente: booker, viaje, pasajeros totales, abordados, pendientes, seats pendientes.

---

## 🚌 Mapa de asientos — Estados y colores

Disponible: fondo #00D4FF | texto blanco | cursor pointer | transición 180ms

Seleccionado: fondo #f59e0b | texto blanco | scale sutil al click | transición 180ms

Reservado: fondo #374151 | texto #6b7280 | cursor not-allowed | transición 180ms

Bloqueado: fondo #7c3aed | opacity 0.7 | cursor not-allowed | transición 180ms

Guía: fondo #00000C | border 2px solid #00D4FF

Boarded: fondo #10b981 | texto blanco | transición 180ms

## Layout del vehículo

El layout depende exclusivamente del tipo de transporte.

Tipos soportados:

- `kia` → 10 puestos
- `bus` → 31 puestos

Nunca generar filas dinámicamente.
Nunca asumir distribución 2-2.
Cada tipo de transporte tiene una distribución física fija.

# Reglas generales de numeración

- A1 siempre está más cerca del frente del vehículo, atrás del asiento del Conductor.
- Los números aumentan hacia el fondo.
- FONDO siempre se muestra arriba del componente.
- FRENTE siempre se muestra abajo del componente.
- La puerta está ubicada en la zona frontal del vehículo.
- Los espacios vacíos representan pasillos o zonas de circulación.
- Los espacios vacíos NO son asientos.
- Solo los IDs existentes en la tabla seats deben ser interactivos.

# Kia — 10 puestos

Distribución física:

    FONDO

[A10][A9][A8][A7]

        [A6][A5]

        [A4][A3]

Puerta [A2][A1]

GUÍA CONDUCTOR

    FRENTE

Reglas Kia:

- El pasillo está ubicado a la izquierda.
- Todos los asientos están ubicados en el lado derecho del vehículo.
- La zona izquierda permanece vacía excepto por la puerta.
- La puerta está en la parte frontal izquierda.
- A1 y A2 son los asientos delanteros.
- A10 es el asiento más cercano al fondo.
- No renderizar asientos inexistentes.

# Autobús — 31 puestos

Distribución física:

          FONDO

[A31][A30][A29][A28][A27]

[A26][A25] [A24][A23]

[A22][A21] [A20][A19]

[A18][A17] [A16][A15]

[A14][A13] [A12][A11]

Puerta [A2][A1]

GUÍA CONDUCTOR

          FRENTE

Reglas Autobús:

- Existe pasillo central vacío.
- El pasillo debe ser un div independiente.
- El pasillo no contiene iconos, texto ni SVG.
- La última fila del fondo siempre contiene 5 puestos.
- A1 y A2 están junto a la puerta.
- La numeración aumenta hacia el fondo.
- Los asientos inexistentes de la última fila no deben renderizarse.

# Estructura visual del vehículo

- **Carrocería exterior:** fondo #d1d5db, border-radius 40px superior / 24px inferior, borde 3px #9ca3af, sombra exterior.

- **Parabrisas:** franja #6b7280 de 24px en la zona frontal inferior, con label "FRENTE".

- **Laterales:** franjas verticales #9ca3af representando ventanas.

- **Cuerpo de pasajeros:** fondo #00000C, padding 16px.

- **Zona inferior/cabina:**

  - Guía: rectángulo 48×48px fondo #166534, borde 2px #00D4FF, label "G" blanco.
  - Conductor: rectángulo 48×48px fondo #ea580c con SVG de volante.

- **Ruedas:** 2 pares delanteras/traseras, 20×36px, border-radius 6px, fondo #1f2937.

- **Puerta:**

  - Rectángulo #9ca3af.
  - Ubicada según layout del vehículo.
  - Label vertical "Puerta Principal".
  - Nunca ocupa un asiento real.

- **Asiento del guía:**
  - Siempre renderizado en zona de cabina.
  - Nunca dentro de la grilla de pasajeros.

# Implementación técnica

El componente BusLayout debe recibir:
vehicleType
seats

Ejemplo:

tsx
<BusLayout vehicleType="bus" seats={seats} />

La distribución debe definirse mediante layouts estáticos:

kia → layout Kia 10 puestos

bus → layout Autobús 31 puestos

No usar:

- cálculos automáticos de filas
- Math.ceil(capacity / 4)
- grids generados dinámicamente
- distribución basada únicamente en cantidad de seats

La leyenda SIEMPRE va encima del mapa, nunca debajo.

"FONDO" va ARRIBA del vehículo.

"FRENTE" va en la zona inferior del vehículo.

El usuario debe ver exactamente la distribución física del transporte.

---

## 🎯 Acciones Primarias

Cada pantalla debe tener UNA sola acción principal.

Nunca mostrar múltiples botones con el mismo peso visual.

---

## 🎨 Iconografía

Usar exclusivamente Lucide.

Stroke: 1.75

Tamaños: 16 — 18 — 20 — 24

No mezclar librerías de iconos.

---

## ✨ Calidad Visual

El sistema debe transmitir:

- simplicidad
- velocidad
- confianza
- limpieza
- precisión

Evitar:

- exceso de bordes
- exceso de colores
- sombras exageradas
- gradientes innecesarios
- interfaces recargadas

El resultado final debe sentirse como un SaaS premium moderno, no como un panel administrativo genérico.

---

## ⛔ Reglas que NUNCA se rompen

1. Nunca hardcodear colores — usar siempre las variables CSS
2. Nunca usar solo placeholder como label de un campo
3. Nunca mostrar botón "Eliminar" sin modal de confirmación
4. Nunca mostrar el alert "Necesitas iniciar sesión" si el usuario ya está autenticado
5. Nunca usar fuentes distintas a Poppins y Montserrat
6. Nunca crear una pantalla completamente blanca sin contexto de marca
7. Nunca dejar un empty state sin CTA que lleve al siguiente paso
8. El panel admin SIEMPRE tiene sidebar, nunca comparte layout con el área pública
9. Los colores oficiales de la marca son #00D4FF (cyan), #0080FF (azul),
   #000024 (navy), #00000C (negro). Nunca aproximar con otros valores.
10. Los logos SVG oficiales están en /public/brand/.
    Nunca crear logos con texto o formas improvisadas.
    Usar siempre los archivos SVG reales.
11. Nunca limpiar el estado de una selección del usuario hasta que
    haya una confirmación visual explícita de éxito o el usuario
    navegue voluntariamente fuera de la pantalla.
12. Todo botón que dispara una acción asíncrona (POST, PUT, DELETE)
    debe tener 3 estados visuales: normal, loading (spinner + disabled),
    y resultado (éxito o error).
13. El boleto siempre muestra TODOS los asientos de una compra,
    nunca solo el primero del array.
14. El campo "Salida" en el boleto usa departure_time del viaje,
    nunca created_at ni updated_at de la reserva.
15. Nunca usar `alert()` ni `confirm()` del navegador — usar siempre Toast y Modal del sistema.
16. Usar exclusivamente Lucide para iconografía — no mezclar librerías.
17. El color cyan (#00D4FF) se reserva para acciones, foco, indicadores, gráficos
    y estados activos — no para bordes decorativos ni fondos de cards.
18. Si una implementación añade, renombra o cambia el default de una variable
    de entorno, el cierre de la tarea DEBE avisarlo de forma explícita:
    qué agregar en Render, en qué servicio (web / worker), valor de soak
    y valor de encendido. Nunca asumir que el default en código basta
    para que el operador se entere.
19. Después de cada cambio de código, y antes de declarar listo o
    proponer commit, ejecutar el build real. En la raíz: `npm run build`
    (`next build`). Si el cambio toca `backend/`, ejecutar también
    `npm run build` en `backend/` (`tsc`). `tsc --noEmit` no sustituye
    el script de build. Si el build falla, corregirlo antes de seguir.

---

## ✅ Protocolo de trabajo del agente

Antes de comenzar cualquier tarea:

1. Leer este archivo completo
2. Identificar qué pantalla/componente se va a modificar
3. Planear los pasos en texto antes de escribir código
4. Verificar que los colores y fuentes a usar están en este archivo

Durante la tarea: 5. Usar solo las variables y valores definidos aquí 6. Si algo no está definido aquí, usar el criterio más cercano que sí esté 7. Si hay ambigüedad real, hacer UNA sola pregunta antes de continuar

Al terminar: 8. Correr el servidor y revisar la consola de errores 9. Si hay errores, corregirlos sin preguntar 10. Verificar contra el checklist de la tarea (ver [`TASKS.md`](TASKS.md); visión de producto en [`docs/ROADMAP.md`](docs/ROADMAP.md)) 11. Ejecutar `npm run build` en la raíz; si hubo cambios en `backend/`, ejecutar también `npm run build` ahí 12. Solo reportar "listo" cuando el servidor y los builds terminen sin errores 13. Si hubo cambios de env vars, incluir un bloque **Render** en el cierre (nombre, servicio, valor soak, cuándo poner `true` / encender). Un default `false` en código no sustituye este aviso.

🔴 Auditoría crítica / seguridad / arquitectura	Nemotron 3 Ultra Free
🟣 Problema complejo / investigación / diseño difícil	Big Pickle
🟢 Implementación de código / refactor / debugging	MiMo-V2.5 Free
🔵 Cambios sencillos / documentación / tareas mecánicas	Nemotron 3.5 Lightning Free

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
