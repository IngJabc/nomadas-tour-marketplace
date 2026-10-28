"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";
import { DatePicker } from "@/components/ui/DatePicker";

const PASSENGER_OPTIONS = [1, 2, 3, 4, 5] as const;

/**
 * Buscador principal del landing. Envía origen, destino, fecha y pasajeros
 * como query params a /trips, donde se aplican como filtros iniciales.
 */
export function BuscadorViajes() {
  const router = useRouter();
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [date, setDate] = useState("");
  const [passengers, setPassengers] = useState<number>(1);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (origin.trim()) params.set("origin", origin.trim());
    if (destination.trim()) params.set("destination", destination.trim());
    if (date) params.set("date", date);
    if (passengers !== 1) params.set("pax", String(passengers));
    const query = params.toString();
    router.push(query ? `/trips?${query}` : "/trips");
  };

  const inputClass =
    "w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm text-brand-navy outline-none transition-shadow placeholder:text-brand-muted focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(212,98,43,0.15)]";
  const labelClass = "mb-1.5 block text-xs font-medium uppercase text-brand-muted";

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Buscar viajes"
      className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_128px_auto] lg:items-end">
        <div>
          <label htmlFor="hero-origin" className={labelClass}>
            Origen
          </label>
          <input
            id="hero-origin"
            type="text"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Ej. Caracas"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="hero-destination" className={labelClass}>
            Destino
          </label>
          <input
            id="hero-destination"
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Ej. Mérida"
            className={inputClass}
          />
        </div>
        <div>
          <DatePicker
            label="Fecha"
            value={date}
            onChange={setDate}
            placeholder="Elige una fecha"
            className="w-full"
          />
        </div>
        <div>
          <label htmlFor="hero-passengers" className={labelClass}>
            Pasajeros
          </label>
          <select
            id="hero-passengers"
            value={passengers}
            onChange={(e) => setPassengers(Number(e.target.value))}
            className={inputClass}
          >
            {PASSENGER_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count} {count === 1 ? "pasajero" : "pasajeros"}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
        >
          <Search size={16} strokeWidth={1.75} aria-hidden />
          Buscar viajes
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </form>
  );
}
