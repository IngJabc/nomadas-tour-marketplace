'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { AlertTriangle, Building2, RefreshCw } from 'lucide-react';
import { publicApi, type PublicAgency } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors/api-error';
import { AgencyCard } from '@/components/agencies/AgencyCard';
import { StateIcon } from '@/components/ui/StateIcon';

// ── REP-001 · Directorio público de agencias ───────────────────────────────
//
// Muestra SOLO lo que publica `GET /api/public/agencies`: identidad, branding,
// calificaciones separadas (agencia / viaje) y viajes publicados. El ORDEN lo
// decide el backend (`is_featured DESC, featured_order ASC, name ASC`): la
// página lo respeta tal cual y lo hace visible con la píldora "Destacada";
// jamás se reordena ni se inventa un ranking aquí.

/** Agencias por página (el backend acepta hasta 50 por request). */
const PAGE_SIZE = 12;

const SKELETON_KEYS = ['sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6'];

const FALLBACK_ERROR = 'No pudimos conectar con el directorio. Intenta de nuevo.';

const secondaryButton =
  'rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40';

export default function AgenciasPage() {
  const [agencies, setAgencies] = useState<PublicAgency[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Última secuencia de carga: descarta respuestas viejas al paginar. */
  const seqRef = useRef(0);

  const load = useCallback(async (targetPage: number) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await publicApi.agencies({
        limit: PAGE_SIZE,
        offset: targetPage * PAGE_SIZE,
      });
      if (seq !== seqRef.current) return;
      setAgencies(result.agencies);
      setTotal(result.total);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(getApiErrorMessage(e, FALLBACK_ERROR));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Si el total se redujo y caímos fuera de rango, volvemos a la última
  // página real. La página siempre baja estrictamente (offset fuera de rango
  // implica page >= pageCount), así que el efecto termina en la página 0.
  useEffect(() => {
    if (loading || error || page === 0 || total === 0) return;
    if (agencies.length > 0) return;
    setPage(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
  }, [loading, error, page, total, agencies.length]);

  const showList = !loading && agencies.length > 0;
  const showFullError = !loading && error !== null && agencies.length === 0;
  const showEmpty = !loading && error === null && agencies.length === 0 && total === 0;
  const showOutOfRange =
    !loading && error === null && agencies.length === 0 && total > 0;
  const showBanner = !loading && error !== null && agencies.length > 0;

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="border-l-4 border-brand-cyan pl-3"
      >
        <h1 className="text-[28px] font-bold">Agencias</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Conectadas al marketplace. Las destacadas aparecen primero, según el
          orden de exhibición del marketplace.
        </p>
      </motion.div>

      <div className="mt-6" aria-live="polite">
        {/* Loading: skeletons de tarjeta (nunca un spinner solo) */}
        {loading && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="flex items-start gap-3">
                  <div className="h-12 w-12 rounded-[10px] bg-black/[0.06]" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-5 w-2/3 rounded bg-black/[0.06]" />
                    <div className="h-3 w-1/3 rounded bg-black/[0.06]" />
                  </div>
                </div>
                <div className="mt-4 h-16 w-full rounded-[10px] bg-black/[0.06]" />
                <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
                <div className="mt-5 h-10 w-full rounded-[10px] bg-black/[0.06]" />
              </div>
            ))}
          </div>
        )}

        {/* Error sin datos: bloque completo con reintento */}
        {showFullError && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
              <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No pudimos cargar las agencias
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
            <button
              type="button"
              onClick={() => void load(page)}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Reintentar
            </button>
          </div>
        )}

        {/* Vacío real: siempre con CTA al siguiente paso */}
        {showEmpty && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <StateIcon>
              <Building2 size={24} strokeWidth={1.75} aria-hidden />
            </StateIcon>
            <h2 className="mt-4 text-lg font-semibold">
              Aún no hay agencias publicadas
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Estamos conectando agencias al marketplace. Explora el catálogo
              de viajes mientras tanto.
            </p>
            <Link
              href="/trips"
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Explorar viajes
            </Link>
          </div>
        )}

        {/* Página fuera de rango (el total se redujo): nunca una pantalla en blanco */}
        {showOutOfRange && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <StateIcon tone="neutral">
              <Building2 size={24} strokeWidth={1.75} aria-hidden />
            </StateIcon>
            <h2 className="mt-4 text-lg font-semibold">
              No hay agencias en esta página
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              El listado cambió desde tu última visita. Vuelve al inicio del
              directorio.
            </p>
            <button
              type="button"
              onClick={() => setPage(0)}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Ver desde el inicio
            </button>
          </div>
        )}

        {/* Error con datos ya cargados: banner inline sin ocultar el listado */}
        {showBanner && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#fef2f2] px-4 py-3"
          >
            <p className="text-sm font-semibold text-[#ef4444]">{error}</p>
            <button
              type="button"
              onClick={() => void load(page)}
              className="inline-flex items-center gap-2 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2]"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Reintentar
            </button>
          </div>
        )}

        {showList && (
          <>
            <p className="text-xs text-brand-muted">
              {total} agencia{total === 1 ? '' : 's'} conectada
              {total === 1 ? '' : 's'}
            </p>

            <div className="mt-4 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {agencies.map((agency, index) => (
                <AgencyCard key={agency.id} agency={agency} index={index} />
              ))}
            </div>

            {pageCount > 1 && (
              <nav
                aria-label="Paginación de agencias"
                className="mt-8 flex items-center justify-between gap-3"
              >
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className={secondaryButton}
                >
                  Anterior
                </button>
                <span className="text-xs text-brand-muted" aria-current="page">
                  Página {page + 1} de {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= pageCount - 1}
                  className={secondaryButton}
                >
                  Siguiente
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </main>
  );
}
