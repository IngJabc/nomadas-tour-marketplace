# Guía de documentación del proyecto

**Propósito:** Mantener la documentación de Nómadas Marketplace clara, sin
duplicados y escalable.

**Cuándo usar este documento:** Al cerrar un sprint, al iniciar una fase del
roadmap, al agregar documentación nueva o cuando un agente/humano no sepa
dónde escribir algo.

**Última actualización:** 2026-09-30

---

## 1. Separación de roles (regla principal)

Cada tipo de documento responde **una sola pregunta**. No mezclar.

| Documento | Pregunta que responde | Qué va aquí | Qué NO va aquí |
| --------- | --------------------- | ----------- | -------------- |
| [`ROADMAP.md`](ROADMAP.md) | ¿Hacia dónde evoluciona el producto? | Fases, objetivos, principios | Tickets de sprint |
| [`../TASKS.md`](../TASKS.md) | ¿Qué hacemos **ahora**? | Sprint actual, bloqueadores, backlog inmediato | Historial cerrado |
| [`architecture.md`](architecture.md) | ¿Cómo está construido el sistema? | Capas, dominios, flujos | Backlog de producto |
| [`system-spec.md`](system-spec.md) | ¿Cuáles son las reglas funcionales base? | Spec, roles, lifecycle | Estado del sprint |
| [`business-rules.md`](business-rules.md) | ¿Qué decisiones de negocio están **aprobadas**? | Reglas consolidadas (6 revisiones) | Spec técnica ni historial |
| [`permissions.md`](permissions.md) | ¿Qué puede hacer cada rol? | RBAC por rol | Reglas de diseño |
| [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) | ¿Qué es este proyecto y cómo funciona? | Stack, comandos, env, estado | Roadmap |
| [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md) | ¿Cómo se conecta con `nomadas-tour`? | EXISTING / PROPOSED / PENDING | Reglas de UI |
| [`../AGENTS.md`](../AGENTS.md) | ¿Cómo debe implementar el agente? | Design tokens, reglas UI, protocolo | Roadmap comercial |

**Regla práctica:** ¿es visión, ejecución, historia, referencia técnica o
contrato con el repo hermano?

---

## 2. Mapa rápido de `docs/`

```
docs/
├── PROJECT_CONTEXT.md            → Contexto maestro del proyecto (empezar aquí)
├── NOMADAS_TOUR_INTEGRATION.md   → Contrato con el repo hermano
├── ROADMAP.md                    → Visión de producto
├── architecture.md               → Arquitectura técnica
├── system-spec.md                → Spec funcional base
├── business-rules.md             → Reglas de negocio aprobadas
├── permissions.md                → Permisos por rol
└── documentation-guide.md        → Cómo mantener docs organizadas (este)

Raíz:
TASKS.md    → Sprint operativo (siempre corto)
AGENTS.md   → Reglas para agentes e implementación
README.md   → Puerta de entrada
```

---

## 3. Al cerrar un sprint

1. Marcar `[x]` las tareas completadas en `TASKS.md`.
2. Mover el detalle a `TASKS-HISTORY.md` (crear cuando cierre el primer
   sprint), agrupado con nombre de sprint y fecha.
3. Dejar `TASKS.md` limpio: sprint actual + próximo + bloqueadores.
4. Si el sprint cerró una fase del ROADMAP, actualizar la tabla de estado.
5. Si apareció una nueva regla de negocio aprobada, añadirla a
   `business-rules.md` (no al ROADMAP).

### Plantilla para entrada en TASKS-HISTORY

```markdown
## Sprint N — Nombre (YYYY-MM-DD)

[x] Tarea principal

- Detalle relevante
- Archivos o endpoints clave
- Validación: tsc ✓, build ✓, tests ✓
```

---

## 4. Al iniciar una fase del ROADMAP

1. Leer la fase en [`ROADMAP.md`](ROADMAP.md).
2. Descomponer en `TASKS.md` con criterios de "done" concretos.
3. Si la fase requiere migraciones o RPC, referenciar desde
   [`NOMADAS_TOUR_INTEGRATION.md`](NOMADAS_TOUR_INTEGRATION.md) § PENDING.
4. No expandir el ROADMAP con subtareas técnicas.

---

## 5. Evitar duplicados

| Situación | Acción |
| --------- | ------ |
| Misma info en TASKS y ROADMAP | ROADMAP = _qué/por qué_; TASKS = _cómo/cuándo_ |
| Tarea completada hace meses | Mover a TASKS-HISTORY |
| Regla de negocio repetida en 3 docs | Una sola fuente: `business-rules.md`; enlazar |
| Doc contradice migraciones vigentes | Migraciones > docs; corregir el doc |
| Regla que también aplica a tour | Anotar en `NOMADAS_TOUR_INTEGRATION.md` y enlazar al doc de tour |

---

## 6. Cuándo crear un documento nuevo

Solo si el tema es **estable**, se consultará repetidamente y no cabe en los
existentes. Antes de crear, **extender un doc existente**.

Nombres: minúsculas con guiones (`backend-deploy.md`).

---

## 7. Anti-patrones

- TASKS.md de 400+ líneas con sprints mezclados.
- Documentar en código lo que es regla de negocio.
- Actualizar AGENTS.md con roadmap comercial.
- Copiar texto de `nomadas-tour` en vez de enlazarlo.
- Tres lugares con la misma lista de próximos pasos.

---

## 8. Referencias cruzadas

| Desde | Enlazar a |
| ----- | --------- |
| `TASKS.md` | ROADMAP, PROJECT_CONTEXT |
| `ROADMAP.md` | TASKS, business-rules |
| `business-rules.md` | NOMADAS_TOUR_INTEGRATION, migrations |
| `AGENTS.md` | TASKS, ROADMAP |
| Nuevo doc en `docs/` | Añadir fila al mapa de §2 |
