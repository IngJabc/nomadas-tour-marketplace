"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Building2, RefreshCw } from "lucide-react";
import { publicApi, type PublicAgency } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { Reveal } from "@/components/ui/Reveal";
import { StateIcon } from "@/components/ui/StateIcon";
import { AgencyCard } from "@/components/agencies/AgencyCard";

/** Máximo de agencias del landing: una grilla de 2×3 estable. */
const MAX_AGENCIAS = 6;

/** Copy público de error: nunca exponer detalles técnicos internos. */
const COPY_ERROR =
  "No pudimos cargar las agencias en este momento. Intenta de nuevo.";

type Estado = "loading" | "error" | "empty" | "ready";

/**
 * Sección de agencias del landing: muestra el primer lote de agencias
 * activas en el orden del directorio (`GET /api/public/agencies`) y lleva
 * al buscador completo de `/agencies`.
 */
export function SeccionAgencias() {
  const [agencies, setAgencies] = useState<PublicAgency[]>([]);
  const [estado, setEstado] = useState<Estado>("loading");
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setEstado("loading");
    try {
      const data = await publicApi.agencies({ limit: MAX_AGENCIAS });
      if (requestId !== requestRef.current) return;
      // Defensa en profundidad: el backend ya recibe `limit`, pero aquí se
      // acota igualmente para que la grilla nunca supere MAX_AGENCIAS.
      setAgencies(data.agencies.slice(0, MAX_AGENCIAS));
      setEstado(data.agencies.length === 0 ? "empty" : "ready");
    } catch {
      if (requestId !== requestRef.current) return;
      setAgencies([]);
      setEstado("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const errorMessage =
    estado === "error"
      ? getApiErrorMessage(new Error("public agencies failed"), COPY_ERROR)
      : null;

  return (
    <section
      data-testid="home-agencias"
      aria-labelledby="home-agencias-titulo"
      className="bg-white py-16"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="border-l-4 border-brand-cyan pl-3">
              <h2
                id="home-agencias-titulo"
                className="font-heading text-2xl font-bold text-brand-navy sm:text-3xl"
              >
                Agencias de confianza
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-brand-muted sm:text-base">
                Reserva con las agencias que operan en Nomadas Tour: perfil
                público, reseñas y sus viajes disponibles en un solo lugar.
              </p>
            </div>
            <Link
              href="/agencies"
              className="inline-flex items-center gap-2 self-start rounded-[10px] border border-slate-200 bg-[#F5F1EC] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e8e2db] sm:self-auto"
            >
              Ver todas las agencias
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </Reveal>

        {estado === "loading" && (
          <div
            data-testid="home-agencias-skeleton"
            aria-busy="true"
            aria-label="Cargando agencias"
            role="status"
            className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          >
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-48 animate-pulse rounded-2xl border border-slate-200/70 bg-slate-100"
              />
            ))}
          </div>
        )}

        {estado === "error" && errorMessage && (
          <div
            data-testid="home-agencias-error"
            role="alert"
            className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-semibold text-amber-800">
                    No pudimos mostrar las agencias
                  </p>
                  <p className="mt-1 text-sm text-amber-700">{errorMessage}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center justify-center gap-2 rounded-[10px] border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Reintentar
              </button>
            </div>
          </div>
        )}

        {estado === "empty" && (
          <div
            data-testid="home-agencias-empty"
            className="mt-8 rounded-2xl border border-slate-200/70 bg-[#F5F1EC] p-8 text-center"
          >
            <StateIcon tone="neutral">
              <Building2 className="h-6 w-6" aria-hidden="true" />
            </StateIcon>
            <p className="mt-4 font-semibold text-brand-navy">
              Aún no hay agencias publicadas
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-brand-muted">
              Pronto verás aquí las agencias conectadas a Nomadas Tour con sus
              viajes disponibles. Mientras tanto, explora el catálogo completo.
            </p>
            <div className="mt-6 flex justify-center">
              <Link
                href="/trips"
                className="inline-flex items-center gap-2 rounded-[10px] bg-[#D4622B] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#B84E1F]"
              >
                Explorar viajes
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        )}

        {estado === "ready" && (
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {agencies.map((agency) => (
              <AgencyCard key={agency.id} agency={agency} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
