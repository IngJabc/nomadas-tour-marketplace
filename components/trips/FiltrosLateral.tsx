"use client";

import { SlidersHorizontal } from "lucide-react";
import { formatSeatPrice } from "@/lib/price";

export type FranjaHoraria = "morning" | "afternoon" | "night";

/** Filtros laterales del catálogo: se aplican de inmediato (sin submit). */
export interface FiltrosViaje {
  horarios: FranjaHoraria[];
  vehiculos: string[];
  agencias: string[];
  /** Precio máximo por asiento en centavos; null = sin límite. */
  precioMax: number | null;
}

export const FILTROS_VIAJE_TODOS: FiltrosViaje = {
  horarios: [],
  vehiculos: [],
  agencias: [],
  precioMax: null,
};

const HORARIOS: { id: FranjaHoraria; label: string }[] = [
  { id: "morning", label: "Mañana (00:00–11:59)" },
  { id: "afternoon", label: "Tarde (12:00–17:59)" },
  { id: "night", label: "Noche (18:00–23:59)" },
];

const VEHICULOS: { id: string; label: string }[] = [
  { id: "bus", label: "Autobús" },
  { id: "kia", label: "Kia" },
];

interface FiltrosLateralProps {
  value: FiltrosViaje;
  onChange: (next: FiltrosViaje) => void;
  /** Agencias del catálogo con su conteo de viajes (para el label del filtro). */
  agencias: { nombre: string; viajes: number }[];
  /** Precio máximo disponible (centavos) para el slider; null si no hay. */
  precioDisponible: number | null;
}

function toggle<T extends string>(list: T[], id: T): T[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * Sidebar de filtros del catálogo (horario, vehículo, agencia, precio).
 * Listas vacías = sin filtro (todos pasan), para no dejar estados muertos.
 */
export function FiltrosLateral({
  value,
  onChange,
  agencias,
  precioDisponible,
}: FiltrosLateralProps) {
  const activo =
    value.horarios.length > 0 ||
    value.vehiculos.length > 0 ||
    value.agencias.length > 0 ||
    value.precioMax !== null;

  const checkboxClass =
    "h-4 w-4 shrink-0 rounded border-[#d1d5db] text-brand-cyan accent-[#D4622B] focus:ring-[3px] focus:ring-[rgba(212,98,43,0.15)] focus:outline-none";

  return (
    <aside aria-label="Filtros de viajes" className="flex flex-col gap-6">
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold">
            <SlidersHorizontal size={18} strokeWidth={1.75} className="text-brand-cyan" aria-hidden />
            Filtros
          </h2>
          {activo && (
            <button
              type="button"
              onClick={() => onChange(FILTROS_VIAJE_TODOS)}
              className="text-xs font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
            >
              Restablecer filtros
            </button>
          )}
        </div>

        {/* Horario de salida (hora de negocio) */}
        <fieldset className="mt-6">
          <legend className="text-xs font-medium uppercase text-brand-muted">
            Horario de salida
          </legend>
          <div className="mt-3 space-y-2.5">
            {HORARIOS.map((horario) => (
              <label key={horario.id} className="flex cursor-pointer items-center gap-2.5 text-sm text-brand-navy">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={value.horarios.includes(horario.id)}
                  onChange={() =>
                    onChange({ ...value, horarios: toggle(value.horarios, horario.id) })
                  }
                />
                {horario.label}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Precio máximo por asiento */}
        <fieldset className="mt-6">
          <legend className="text-xs font-medium uppercase text-brand-muted">
            Precio máximo por asiento
          </legend>
          {precioDisponible === null || precioDisponible <= 0 ? (
            <p className="mt-3 text-sm text-brand-muted">
              El catálogo aún no tiene precios publicados.
            </p>
          ) : (
            <div className="mt-3">
              <input
                type="range"
                aria-label="Precio máximo por asiento"
                min={0}
                max={precioDisponible}
                step={100}
                value={value.precioMax ?? precioDisponible}
                onChange={(e) => {
                  const cents = Number(e.target.value);
                  onChange({
                    ...value,
                    precioMax: cents >= precioDisponible ? null : cents,
                  });
                }}
                className="w-full accent-[#D4622B]"
              />
              <p className="mt-2 text-sm font-semibold text-brand-navy">
                {value.precioMax === null
                  ? "Sin límite"
                  : `Hasta ${formatSeatPrice(value.precioMax)}`}
              </p>
            </div>
          )}
        </fieldset>

        {/* Vehículo */}
        <fieldset className="mt-6">
          <legend className="text-xs font-medium uppercase text-brand-muted">
            Vehículo
          </legend>
          <div className="mt-3 space-y-2.5">
            {VEHICULOS.map((vehiculo) => (
              <label key={vehiculo.id} className="flex cursor-pointer items-center gap-2.5 text-sm text-brand-navy">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={value.vehiculos.includes(vehiculo.id)}
                  onChange={() =>
                    onChange({ ...value, vehiculos: toggle(value.vehiculos, vehiculo.id) })
                  }
                />
                {vehiculo.label}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Agencia */}
        {agencias.length > 0 && (
          <fieldset className="mt-6">
            <legend className="text-xs font-medium uppercase text-brand-muted">
              Agencia
            </legend>
            <div className="mt-3 space-y-2.5">
              {agencias.map((agencia) => (
                <label key={agencia.nombre} className="flex cursor-pointer items-center gap-2.5 text-sm text-brand-navy">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={value.agencias.includes(agencia.nombre)}
                    onChange={() =>
                      onChange({
                        ...value,
                        agencias: toggle(value.agencias, agencia.nombre),
                      })
                    }
                  />
                  {agencia.nombre} ({agencia.viajes})
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </aside>
  );
}
