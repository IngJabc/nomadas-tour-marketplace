# Nómadas Marketplace

Storefront público B2C del ecosistema **Nómadas**: busca viajes de agencias
conectadas, elige tus asientos en el mapa del vehículo, sube tu comprobante de
pago y recibe tu boleto con QR.

Compañero de [`nomadas-tour`](../nomadas-tour) (panel B2B de agencias y
boarding). Mismo stack, misma BD Supabase, repos separados.

---

## Empezar aquí

1. **[`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md)** — qué es el
   proyecto, stack, estructura, comandos y estado.
2. **[`docs/NOMADAS_TOUR_INTEGRATION.md`](docs/NOMADAS_TOUR_INTEGRATION.md)**
   — qué se reutiliza de tour, qué está aprobado y qué está pendiente.
3. **[`AGENTS.md`](AGENTS.md)** — reglas de diseño e implementación
   (obligatorio antes de codear).
4. **[`TASKS.md`](TASKS.md)** — sprint operativo.
5. **[`docs/ROADMAP.md`](docs/ROADMAP.md)** — fases de producto.

---

## Comandos

```bash
npm install
npm install --prefix backend

npm run dev                 # Frontend → http://localhost:3000
npm run dev --prefix backend    # API → http://localhost:3001/healthz
npm run dev:all             # ambos

npm run build               # build producción (Next.js)
npm run build --prefix backend  # build producción (tsc)
npm test                    # tests frontend
npm run test --prefix backend   # tests backend
npm run audit:deps          # vulnerabilidades (high)
```

Configuración: copia `.env-example` → `.env` y
`backend/.env-example` → `backend/.env`.

---

## Stack

Next.js 16.3.5 · React 19 · TypeScript · Tailwind CSS v4 · Supabase
(Auth + Postgres + Realtime + RLS) · Express 5 (ESM) · Zod · Vitest.

Detalle y versiones: [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) §2.

---

## Estructura

```
app/         → páginas Next.js (App Router)
components/  → UI (Navbar, Toast, Auth)
lib/         → API client, supabase, auth, utils
backend/     → API Express (auth, catálogo, healthz)
supabase/    → migraciones marketplace (074+)
docs/        → documentación completa
```

---

## Reglas

- Leer [`AGENTS.md`](AGENTS.md) antes de cualquier tarea.
- Design tokens, mapa de asientos y prohibiciones: ahí mismo.
- Build obligatorio antes de declarar listo (regla 19).
- Sin commits/pushes automáticos: los hace el usuario.
