'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bus,
  MessageCircle,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import {
  publicApi,
  type AgencyPublicContact,
  type PublicAgencyProfile,
  type PublicTrip,
} from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors/api-error';
import { whatsappHref } from '@/lib/booking/whatsapp';
import { precioMaximoDe, viajePasaFiltros } from '@/lib/trips/filters';
import { AgencyContactLinks } from '@/components/booking/AgencyContactLinks';
import { AgencyLogo, safeHexColor } from '@/components/agencies/AgencyLogo';
import { AgencyRatingsSummary } from '@/components/agencies/AgencyRatingsSummary';
import { agencyBrandVars } from '@/components/agencies/branding';
import { tripsSummaryLabel } from '@/components/agencies/tripsSummary';
import { TarjetaViaje } from '@/components/trips/TarjetaViaje';
import {
  FiltrosLateral,
  FILTROS_VIAJE_TODOS,
  type FiltrosViaje,
} from '@/components/trips/FiltrosLateral';
import { RailLateral } from '@/components/trips/RailLateral';
import { DatePicker } from '@/components/ui/DatePicker';
import { PillBadge } from '@/components/ui/PillBadge';
import { Reveal } from '@/components/ui/Reveal';
import { StateIcon } from '@/components/ui/StateIcon';

// ── REP-001 · Storefront público de una agencia ─────────────────────────────
//
// Cada agencia se presenta como su propia tienda dentro de Nómadas
// Marketplace, con la estructura de un storefront completo:
//   1. Banner de identidad (logo + nombre + branding validado de la base)
//   2. "Sobre la agencia" (solo datos de la API, sin copy inventado) +
//      contacto PÚBLICO (agency_contacts 091 + teléfono legado)
//   3. El MISMO catálogo de `/trips`: filtros laterales (`FiltrosLateral`),
//      tarjeta (`TarjetaViaje`) y mismos estados
//   4. Calificaciones SIEMPRE separadas + KPIs de la agencia
// Los filtros de origen/destino/fecha siguen siendo server-side sobre
// `GET /api/public/agencies/:agencyId`; las facetas laterales (horario,
// vehículo, precio) se aplican sobre la página cargada. JAMÁS se pintan
// contactos privados ni métodos de pago.

interface Filters {
  origin: string;
  destination: string;
  date: string;
}

const EMPTY_FILTERS: Filters = { origin: '', destination: '', date: '' };

/** Viajes por página (el backend acepta hasta 50 por request). */
const PAGE_SIZE = 12;

const SKELETON_KEYS = ['sk-1', 'sk-2', 'sk-3'];

const FALLBACK_ERROR = 'No pudimos conectar con la agencia. Intenta de nuevo.';

const secondaryButton =
  'rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40';

const inputClass =
  'w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm font-normal text-brand-navy outline-none transition-shadow placeholder:text-brand-muted focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(212,98,43,0.15)]';

const labelClass = 'mb-1.5 block text-xs font-medium uppercase text-brand-muted';

const cardClass =
  'rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]';

// Barra de sección en el color primario de la AGENCIA (variable aislada
// `--agency-primary` con fallback a la token del Marketplace).
const sectionTitleClass =
  'border-l-4 border-[var(--agency-primary,var(--color-brand-cyan))] pl-3';

/** URL http(s) válida para logo/portada; cualquier otra se ignora. */
function isValidImageUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Contacto público ya filtrado por el backend; el resto jamás se pinta. */
interface ContactSectionProps {
  contacts: AgencyPublicContact[];
  phone: string | null;
}

function ContactSection({ contacts, phone }: ContactSectionProps) {
  // El backend solo devuelve contactos públicos + activos; el teléfono
  // legado también es público (006/011). Nada más llega a este componente.
  if (contacts.length > 0) {
    return <AgencyContactLinks contacts={contacts} className="mt-3" />;
  }

  const legacyWhatsApp = whatsappHref(phone);
  if (!phone) {
    return (
      <p className="mt-3 text-sm text-brand-muted">
        Esta agencia aún no publica canales de contacto.
      </p>
    );
  }

  return (
    <div className="mt-3">
      {legacyWhatsApp ? (
        <a
          href={legacyWhatsApp}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-[10px] bg-[#10b981] px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#059669]"
        >
          <MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" />
          Contactar por WhatsApp
        </a>
      ) : (
        <p className="text-xs text-brand-muted">
          No pudimos abrir WhatsApp con este número. Contáctalos al número
          publicado.
        </p>
      )}
      <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-brand-navy">
        <Phone
          size={16}
          strokeWidth={1.75}
          className="text-[var(--agency-primary-text,var(--color-brand-cyan))]"
          aria-hidden
        />
        {phone}
      </p>
    </div>
  );
}

export default function AgenciaPerfilPage() {
  const params = useParams<{ agencyId?: string }>();
  const agencyId = params?.agencyId;

  const [agency, setAgency] = useState<PublicAgencyProfile | null>(null);
  const [trips, setTrips] = useState<PublicTrip[]>([]);
  const [tripsTotal, setTripsTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  /** Facetas laterales del catálogo (mismo contrato que `/trips`). */
  const [viajeFilters, setViajeFilters] = useState<FiltrosViaje>(
    FILTROS_VIAJE_TODOS,
  );
  /** Portada rota (404/CDN caído): se oculta y queda el banner de marca. */
  const [coverFailed, setCoverFailed] = useState(false);

  /** Última secuencia de carga: descarta respuestas viejas al filtrar. */
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    if (!agencyId) {
      setAgency(null);
      setTrips([]);
      setTripsTotal(0);
      setLoading(false);
      return;
    }

    try {
      const result = await publicApi.agencyDetail(agencyId, {
        origin: applied.origin.trim() || undefined,
        destination: applied.destination.trim() || undefined,
        date: applied.date || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (seq !== seqRef.current) return;
      setAgency(result.agency);
      setTrips(result.agency.trips ?? []);
      setTripsTotal(result.agency.trips_total ?? 0);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(getApiErrorMessage(e, FALLBACK_ERROR));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [agencyId, applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setCoverFailed(false);
  }, [agency?.cover_url]);

  const pageCount = Math.max(1, Math.ceil(tripsTotal / PAGE_SIZE));

  // Si el total se redujo y caímos fuera de rango, volvemos a la última
  // página real: nunca una rejilla en blanco. La baja estricta de `page`
  // garantiza que el efecto termina en la página 0.
  useEffect(() => {
    if (loading || error || page === 0 || tripsTotal === 0) return;
    if (trips.length > 0) return;
    setPage(Math.max(0, Math.ceil(tripsTotal / PAGE_SIZE) - 1));
  }, [loading, error, page, tripsTotal, trips.length]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setPage(0);
    setApplied({ ...filters });
  };

  const handleClear = () => {
    setPage(0);
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setViajeFilters(FILTROS_VIAJE_TODOS);
  };

  const hasServerFilters =
    applied.origin.trim() !== '' ||
    applied.destination.trim() !== '' ||
    applied.date !== '';
  const hasFacetFilters =
    viajeFilters.horarios.length > 0 ||
    viajeFilters.vehiculos.length > 0 ||
    viajeFilters.agencias.length > 0 ||
    viajeFilters.precioMax !== null;
  const hasActiveFilters = hasServerFilters || hasFacetFilters;

  // Resultados de la página cargada, ya filtrados en servidor por
  // origen/destino/fecha y ahora por las facetas laterales (client-side,
  // mismo predicado que el catálogo general).
  const visibleTrips = useMemo(
    () => trips.filter((trip) => viajePasaFiltros(trip, viajeFilters)),
    [trips, viajeFilters],
  );

  // Precio máximo disponible para el slider: calculado sobre la página
  // cargada (mismo helper que `/trips`).
  const precioDisponible = useMemo(() => precioMaximoDe(trips), [trips]);

  const showSidebar = !loading && trips.length > 0;
  const showFullError = !loading && error !== null && agency === null;
  const serverEmpty =
    !loading && error === null && trips.length === 0 && tripsTotal === 0;
  /** Con filtros server-side el vacío es "sin coincidencias", no "sin viajes". */
  const showNoMatch = serverEmpty && hasServerFilters;
  const showNoTrips = serverEmpty && !hasServerFilters;
  /** La página cargada existe pero las facetas laterales la dejaron vacía. */
  const facetsEmpty =
    !loading && error === null && trips.length > 0 && visibleTrips.length === 0;
  const showOutOfRange =
    !loading && error === null && trips.length === 0 && tripsTotal > 0;

  const tint = agency
    ? safeHexColor(agency.primary_color) ??
      safeHexColor(agency.secondary_color) ??
      safeHexColor(agency.accent_color)
    : null;

  /** Portada del storefront (Phase 7): solo si la URL es válida. */
  const coverUrl =
    agency && !coverFailed && isValidImageUrl(agency.cover_url)
      ? agency.cover_url
      : null;



  return (
    <main
      id="main"
      className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6"
      style={agencyBrandVars(agency)}
    >
      {/* Banner de identidad: base oscura de la marca con el color de la
          agencia superpuesto al 22% (cualquier color, incluso claro, mantiene
          contraste AA con el texto blanco) + franja superior en color pleno.
          Si la agencia publica portada (Phase 7) ésta va a sangre arriba y el
          padding pasa al contenido; sin portada el banner queda idéntico.
          El h1 conserva el mismo margen izquierdo (border-l-4 + pl-3) que el
          resto de páginas. */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        data-testid="agency-storefront"
        className={`relative overflow-hidden rounded-2xl border-l-4 border-[var(--agency-primary,var(--color-brand-cyan))] bg-brand-dark pb-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${
          coverUrl ? '' : 'pl-3 pr-4 pt-4 sm:pr-6 sm:pt-5'
        }`}
      >
        {tint && (
          <span
            data-testid="agency-branding-tint"
            aria-hidden="true"
            className="absolute inset-0"
            style={{ backgroundColor: tint, opacity: 0.22 }}
          />
        )}
        {tint && (
          <span
            data-testid="agency-branding-strip"
            aria-hidden="true"
            className="absolute inset-x-0 top-0 z-10 h-1.5"
            style={{ backgroundColor: tint }}
          />
        )}

        {agency && coverUrl && (
          <img
            src={coverUrl}
            alt={`Portada de ${agency.name}`}
            onError={() => setCoverFailed(true)}
            className="relative block h-32 w-full object-cover sm:h-44"
          />
        )}

        <div
          className={`relative ${coverUrl ? 'pl-3 pr-4 pt-4 sm:pr-6 sm:pt-5' : ''}`}
        >
          <Link
            href="/agencies"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/75 transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
            Todas las agencias
          </Link>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            {agency && (
              <AgencyLogo
                logoUrl={agency.logo_url}
                name={agency.name}
                primaryColor={agency.primary_color}
                size={72}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[28px] font-bold leading-tight text-white">
                  {agency ? agency.name : 'Agencia'}
                </h1>
                {agency?.is_featured && (
                  <PillBadge className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    Destacada
                  </PillBadge>
                )}
              </div>
              {agency?.slogan?.trim() && (
                <p className="mt-1 text-[15px] font-medium text-white/90">
                  {agency.slogan.trim()}
                </p>
              )}
              <p className="mt-1 text-sm text-white/75">
                {agency
                  ? ''
                  : error
                    ? 'Este perfil no está disponible en este momento.'
                    : 'Cargando el perfil público de la agencia…'}
              </p>
              {agency && (
                <p className="mt-2 flex items-center gap-2 text-sm text-white/85">
                  <Bus
                    size={16}
                    strokeWidth={1.75}
                    className="text-brand-cyan"
                    aria-hidden
                  />
                  <span className="text-[15px] font-semibold">
                    {tripsSummaryLabel(agency.published_trips_count, false)}
                  </span>
                </p>
              )}
            </div>
           
          </div>
        </div>
      </motion.div>

      <div className="mt-6 space-y-6" aria-live="polite">
        {/* Loading inicial: esqueleto de la fila informativa + rejilla */}
        {loading && !agency && (
          <>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
              <div className={`${cardClass} animate-pulse`}>
                <div className="h-6 w-40 rounded bg-black/[0.06]" />
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="h-20 rounded-[10px] bg-black/[0.06]" />
                  <div className="h-20 rounded-[10px] bg-black/[0.06]" />
                </div>
              </div>
              <div className={`${cardClass} animate-pulse`}>
                <div className="h-6 w-32 rounded bg-black/[0.06]" />
                <div className="mt-4 h-4 w-3/4 rounded bg-black/[0.06]" />
                <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
              </div>
            </div>
            <div className="grid gap-8 sm:grid-cols-2">
              {SKELETON_KEYS.map((key) => (
                <div
                  key={key}
                  className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                >
                  <div className="h-5 w-24 rounded-full bg-black/[0.06]" />
                  <div className="mt-4 h-5 w-3/4 rounded bg-black/[0.06]" />
                  <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
                  <div className="mt-6 h-10 w-full rounded-[10px] bg-black/[0.06]" />
                </div>
              ))}
            </div>
          </>
        )}

        {/* Error sin perfil: bloque completo con reintento */}
        {showFullError && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
              <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No pudimos cargar esta agencia
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                Reintentar
              </button>
              <Link
                href="/agencies"
                className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
              >
                Ver todas las agencias
              </Link>
            </div>
          </div>
        )}

        {agency && (
          <>
            {/* Presentación + contacto público (fila superior del storefront) */}
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
              <section
                aria-labelledby="agency-about-title"
                className={cardClass}
              >
                <h2
                  id="agency-about-title"
                  className={`${sectionTitleClass} text-[20px] font-semibold sm:text-[22px]`}
                >
                  Sobre la agencia
                </h2>
                {/* Phase 7: la agencia publica su propia descripción
                    comercial; sin ella se mantiene el texto generado con
                    datos verificables del perfil. Jamás copy inventado. */}
                {agency.description?.trim() && (
                  <p className="mt-3 text-sm leading-relaxed text-brand-navy">
                    {agency.description.trim()}
                  </p>
                )}               
              </section>

              <section
                aria-labelledby="agency-contact-title"
                className={cardClass}
              >
                <h2
                  id="agency-contact-title"
                  className={`${sectionTitleClass} text-[20px] font-semibold sm:text-[22px]`}
                >
                  Contacto público
                </h2>
                <p className="mt-1 text-sm text-brand-muted">
                  Canales activos que la agencia publica para sus pasajeros.
                </p>
                <ContactSection
                  contacts={agency.contacts ?? []}
                  phone={agency.phone}
                />
              </section>
            </div>

            {/* Catálogo de la agencia: mismo layout que `/trips` */}
            <section
              id="agency-trips"
              aria-labelledby="agency-trips-title"
            >
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className={sectionTitleClass}>
                  <h2
                    id="agency-trips-title"
                    className="text-[20px] font-semibold sm:text-[22px]"
                  >
                    Viajes de la agencia
                  </h2>
                  <p className="mt-1 text-sm text-brand-muted">
                    Busca por origen, destino y fecha, o refina con los filtros
                    del catálogo.
                  </p>
                </div>               
              </div>

              {/* Filtros server-side (origin/destination/date), mismo contrato
                  que la banda de búsqueda del catálogo general */}
              <form
                onSubmit={handleSubmit}
                aria-label="Filtrar viajes de la agencia"
                className="mt-4 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                  <div>
                    <label htmlFor="agency-filter-origin" className={labelClass}>
                      Origen
                    </label>
                    <input
                      id="agency-filter-origin"
                      type="text"
                      value={filters.origin}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, origin: e.target.value }))
                      }
                      placeholder="Ej. Barquisimeto"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="agency-filter-destination" className={labelClass}>
                      Destino
                    </label>
                    <input
                      id="agency-filter-destination"
                      type="text"
                      value={filters.destination}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, destination: e.target.value }))
                      }
                      placeholder="Ej. Caracas"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <DatePicker
                      label="Fecha"
                      value={filters.date}
                      onChange={(date) => setFilters((f) => ({ ...f, date }))}
                      placeholder="Elige una fecha"
                      className="w-full"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--agency-primary,var(--color-brand-cyan))] px-5 py-3 text-sm font-semibold text-[var(--agency-primary-ink,#fff)] transition-colors duration-200 hover:bg-[var(--agency-secondary,var(--color-brand-blue))] hover:text-[var(--agency-secondary-ink,#fff)] sm:w-auto"
                    >
                      <Search size={16} strokeWidth={1.75} aria-hidden />
                      Buscar
                    </button>
                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={handleClear}
                        className="min-h-[48px] rounded-[10px] bg-[#F5F1EC] px-5 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#ece5db]"
                      >
                        Limpiar filtros
                      </button>
                    )}
                  </div>
                </div>
              </form>

              {/* Error en refresco con el perfil ya cargado: banner inline */}
              {!loading && error !== null && (
                <div
                  role="alert"
                  className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#fef2f2] px-4 py-3"
                >
                  <p className="text-sm font-semibold text-[#ef4444]">{error}</p>
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="inline-flex items-center gap-2 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2]"
                  >
                    <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                    Reintentar
                  </button>
                </div>
              )}

              <div
                className={`mt-6 grid items-start gap-8 ${
                  showSidebar
                    ? 'lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_300px]'
                    : ''
                }`}
              >
                {/* Mismo sidebar de facetas que `/trips`. La faceta de agencia
                    no aplica dentro del storefront de UNA agencia (todas las
                    salidas ya son suyas), así que viaja vacía y se oculta. */}
                {showSidebar && (
                  <Reveal className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-96px)] lg:overflow-y-auto lg:pb-2">
                    <FiltrosLateral
                      value={viajeFilters}
                      onChange={setViajeFilters}
                      agencias={[]}
                      precioDisponible={precioDisponible}
                    />
                  </Reveal>
                )}

                {/* Resultados */}
                <div>
                  {loading && agency && (
                    <div className="grid gap-8 sm:grid-cols-2">
                      {SKELETON_KEYS.map((key) => (
                        <div
                          key={key}
                          className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                        >
                          <div className="h-5 w-24 rounded-full bg-black/[0.06]" />
                          <div className="mt-4 h-5 w-3/4 rounded bg-black/[0.06]" />
                          <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
                          <div className="mt-6 h-10 w-full rounded-[10px] bg-black/[0.06]" />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Sin resultados (filtros server-side o facetas laterales):
                      CTA para limpiar, siempre el mismo paso siguiente */}
                  {(showNoMatch || facetsEmpty) && (
                    <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                      <StateIcon>
                        <Search size={24} strokeWidth={1.75} aria-hidden />
                      </StateIcon>
                      <h2 className="mt-4 text-lg font-semibold">
                        No hay viajes que coincidan con tu búsqueda
                      </h2>
                      <p className="mt-2 max-w-md text-sm text-brand-muted">
                        Prueba con otro origen, destino o fecha.
                      </p>
                      <button
                        type="button"
                        onClick={handleClear}
                        className="mt-6 rounded-[10px] bg-[#F5F1EC] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#ece5db]"
                      >
                        Limpiar filtros
                      </button>
                    </div>
                  )}

                  {/* La agencia todavía no publica viajes: CTA al catálogo completo */}
                  {showNoTrips && (
                    <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                      <StateIcon>
                        <Bus size={24} strokeWidth={1.75} aria-hidden />
                      </StateIcon>
                      <h2 className="mt-4 text-lg font-semibold">
                        Esta agencia aún no tiene viajes publicados
                      </h2>
                      <p className="mt-2 max-w-md text-sm text-brand-muted">
                        Explora el catálogo completo mientras esta agencia prepara
                        sus próximas salidas.
                      </p>
                      <Link
                        href="/trips"
                        className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                      >
                        Explorar todos los viajes
                      </Link>
                    </div>
                  )}

                  {/* Página fuera de rango (el total se redujo): nunca en blanco */}
                  {showOutOfRange && (
                    <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                      <StateIcon tone="neutral">
                        <Bus size={24} strokeWidth={1.75} aria-hidden />
                      </StateIcon>
                      <h2 className="mt-4 text-lg font-semibold">
                        No hay viajes en esta página
                      </h2>
                      <p className="mt-2 max-w-md text-sm text-brand-muted">
                        El listado cambió desde tu última visita. Vuelve a la
                        primera página.
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

                  {!loading && visibleTrips.length > 0 && (
                    <>
                      {/* La cifra del encabezado ya cubre el total sin filtros:
                          esta línea solo añade valor con filtros, facetas o
                          paginación. */}
                      {(hasActiveFilters ||
                        pageCount > 1 ||
                        visibleTrips.length < trips.length) && (
                        <p className="text-xs text-brand-muted">
                          {visibleTrips.length < trips.length
                            ? `Mostrando ${visibleTrips.length} de ${trips.length} viajes de esta página`
                            : hasServerFilters
                              ? tripsSummaryLabel(tripsTotal, true)
                              : `Mostrando ${trips.length} de ${tripsTotal} viajes`}
                        </p>
                      )}

                      <div className="mt-4 grid gap-8 sm:grid-cols-2">
                        {visibleTrips.map((trip, index) => (
                          <TarjetaViaje key={trip.id} trip={trip} index={index} />
                        ))}
                      </div>

                      {pageCount > 1 && (
                        <nav
                          aria-label="Paginación de viajes de la agencia"
                          className="mt-6 flex items-center justify-between gap-3"
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

                {/* Rail lateral derecho: solo cuando existe la 3ª columna (xl),
                    mismo contenido editorial del catálogo general */}
                {showSidebar && (
                  <div className="hidden xl:block xl:sticky xl:top-24">
                    <RailLateral />
                  </div>
                )}
              </div>
            </section>

            {/* Cierre del storefront: calificaciones (siempre separadas) y el
                KPI de viajes en UNA tarjeta oscura compacta — así la fila no
                queda con un bloque oscuro casi vacío — + contexto de reserva.
                `items-start` evita que las tarjetas se estiren a la altura
                de la columna vecina. */}
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
              <section
                aria-labelledby="agency-ratings-title"
                className="rounded-2xl bg-brand-dark p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <h2
                  id="agency-ratings-title"
                  className={`${sectionTitleClass} text-[20px] font-semibold text-white sm:text-[22px]`}
                >
                  Calificaciones
                </h2>
                <p className="mt-1 text-sm text-white/70">
                  Reseñas de la agencia y de sus viajes, siempre por separado.
                </p>
                <div className="mt-4">
                  <AgencyRatingsSummary
                    ratings={agency.ratings}
                    variant="panel"
                  />
                </div>

                {/* Zona de datos: el KPI comparte tarjeta con las
                    calificaciones para equilibrar la fila con contenido real. */}
                <div className="mt-5 border-t border-white/10 pt-5">
                  <h3
                    id="agency-stat-title"
                    className="flex items-center gap-2 text-[17px] font-semibold text-white"
                  >
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white/10 text-brand-cyan"
                      aria-hidden
                    >
                      <Bus size={18} strokeWidth={1.75} />
                    </span>
                    Viajes publicados
                  </h3>
                  <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[32px] font-extrabold leading-none text-white">
                      {agency.published_trips_count}
                    </span>
                    <span className="text-sm text-white/70">
                      Reservables ahora en Nómadas Marketplace.
                    </span>
                  </div>
                  <a
                    href="#agency-trips"
                    className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
                  >
                    Ir a los viajes
                    <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
                  </a>
                </div>
              </section>

              {/* Contexto de reserva del Marketplace (contenido real del
                  producto, no información inventada de la agencia) */}
              <section
                aria-labelledby="agency-reserve-title"
                className={cardClass}
              >
                <h2
                  id="agency-reserve-title"
                  className="flex items-center gap-2 text-[17px] font-semibold"
                >
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#ecfdf5] text-[#176B62]"
                    aria-hidden
                  >
                    <ShieldCheck size={18} strokeWidth={1.75} />
                  </span>
                  Reserva en línea
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-brand-muted">
                  Elige un viaje de esta agencia, selecciona tus asientos y
                  paga en línea. Al confirmar tu pago recibes tu boleto con
                  QR.
                </p>
                <Link
                  href="/trips"
                  className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#F5F1EC] px-5 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#ece5db]"
                >
                  Explorar el catálogo completo
                </Link>
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
