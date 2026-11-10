import { supabaseAdmin } from '../config/database.js';
import { AppError, InternalError, ValidationError } from '../errors/index.js';
import {
  mapPublicAgencyContact,
  mapPublicTripRow,
  type PublicAgencyContactDto,
  type PublicAgencyContactRow,
  type PublicTripListItemDto,
} from './public-trip.mapper.js';

// ── REP-001 · Directorio y perfil público de agencias ──────────────────────
//
// Fase 1 (backend + base de datos): superficie PÚBLICA de agencias para el
// storefront. Expone SOLO datos públicos:
//   * identidad (name, subdomain),
//   * branding (agency_settings, 041),
//   * contacto PÚBLICO (agency_contacts con is_public/is_active, 091) y el
//     teléfono legado público de agencies (006/011),
//   * viajes publicados (095) con la misma forma del catálogo,
//   * estadísticas públicas (calificaciones + contador de viajes).
//
// JAMÁS expone: email de acceso, métodos de pago (089), datos de clientes,
// reservas, comprobantes ni nada que no sea público por diseño.
//
// CALIFICACIONES SEPARADAS (decisión de producto): nunca se calcula un
// promedio combinado. `ratings.agency` y `ratings.trip` viajan como dos
// estadísticas independientes y el frontend decide cómo presentarlas.
//   * agency → avg/count de `agency_reviews` visibles de ESA agencia.
//   * trip   → avg/count de `trip_reviews` visibles sobre los viajes que
//              ESA agencia opera (trip_agencies). La reseña de viaje no
//              guarda agencia (099): se atribuye por el viaje, que es
//              exactamente lo que el perfil muestra.
//
// TOLERANCIA A MIGRACIONES DE RESEÑAS: 097-099 están escritas pero NO
// aplicadas en todos los entornos. Si `agency_reviews` / `trip_reviews`
// aún no existen, los endpoints NO fallan: devuelven
// `{ average: null, count: 0 }` (ver `isRelationMissing`). Las columnas
// que SÍ son dependencia dura (agencias, agency_settings, agency_contacts,
// trip_agencies, trips) se tratan como error real.

// ── Tipos / DTOs ────────────────────────────────────────────────────────────

/** Promedio redondeado a 1 decimal; `null` cuando no hay reseñas. */
export interface RatingStat {
  average: number | null;
  count: number;
}

/** Las dos calificaciones SIEMPRE separadas (nunca un combinado). */
export interface AgencyRatings {
  agency: RatingStat;
  trip: RatingStat;
}

/** Fila pública de agencia del directorio. */
export interface PublicAgencyDto {
  id: string;
  name: string;
  subdomain: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  is_featured: boolean;
  featured_order: number;
  ratings: AgencyRatings;
  /** Viajes reservables hoy (active + is_published + salida futura). */
  published_trips_count: number;
}

/** Perfil público: directorio + contacto + viajes. */
export interface PublicAgencyProfileDto extends PublicAgencyDto {
  /** Teléfono legado público de `agencies` (006/011); fallback si no hay contactos. */
  phone: string | null;
  /** Phase 7 — presentación del storefront (solo en el perfil, no en el directorio). */
  cover_url: string | null;
  slogan: string | null;
  description: string | null;
  contacts: PublicAgencyContactDto[];
  /** Página de viajes según los filtros del request. */
  trips: PublicTripListItemDto[];
  /** Total de viajes que matchean los filtros (no solo la página). */
  trips_total: number;
}

export interface PublicAgencyListResult {
  agencies: PublicAgencyDto[];
  total: number;
}

export interface AgencyTripsFilters {
  origin?: string | undefined;
  destination?: string | undefined;
  date?: string | undefined;
}

// ── Constantes ──────────────────────────────────────────────────────────────

const BRANDING_COLUMNS =
  'agency_settings(logo_url, primary_color, secondary_color, accent_color)';

const DIRECTORY_AGENCY_COLUMNS = `id, name, subdomain, is_featured, featured_order, ${BRANDING_COLUMNS}`;

/**
 * Phase 7 — el perfil público además expone la presentación del
 * storefront (portada, slogan, descripción). El directorio (lista) NO
 * las incluye: `BRANDING_COLUMNS` sigue siendo su contrato.
 */
const PROFILE_BRANDING_COLUMNS = `agency_settings(logo_url, primary_color, secondary_color, accent_color, cover_url, description, slogan)`;

const PROFILE_AGENCY_COLUMNS = `id, name, subdomain, phone, is_featured, featured_order, ${PROFILE_BRANDING_COLUMNS}`;

// Espejo del select del catálogo (`routes/public/trips.ts`) con una sola
// diferencia: `routes!inner` para poder filtrar por origin/destination en
// el padre. `route_id` es NOT NULL con FK (011), así que `!inner` no
// descarta ningún viaje. El mapeo fila→DTO es compartido (public-trip.mapper).
const AGENCY_TRIP_COLUMNS =
  'id, departure_time, capacity, vehicle_type, status, seat_price, ' +
  'routes!inner(origin, destination), ' +
  'trip_agencies(agency_id, agencies(id, name, status)), seats(status)';

/** Zona de negocio del Marketplace: los días se cuentan en Caracas. */
const BUSINESS_TIMEZONE = 'America/Caracas';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Helpers ─────────────────────────────────────────────────────────────────

type QueryError = { code?: string; message?: string } | null | undefined;

/**
 * ¿El fallo de PostgREST es porque la relación NO existe en el esquema?
 *
 * Se usa para tolerar las migraciones de reseñas 097-099 todavía no
 * aplicadas: en ese caso el endpoint sigue respondiendo con ratings vacíos
 * en lugar de 500. Cualquier OTRO error (permisos, timeout, columna rota
 * por otra causa) sigue siendo error real.
 */
export function isRelationMissing(error: QueryError): boolean {
  if (!error) return false;
  // PGRST205: table/view not found in schema cache.
  // PGRST204: column not found in schema cache.
  if (error.code === 'PGRST205' || error.code === 'PGRST204') return true;
  return /does not exist|could not find the/i.test(error.message ?? '');
}

function emptyRating(): RatingStat {
  return { average: null, count: 0 };
}

function ratingFrom(sum: number, count: number): RatingStat {
  if (count <= 0) return emptyRating();
  return { average: Math.round((sum / count) * 10) / 10, count };
}

/** Patrón `ILIKE ...%...` escapando los comodines de LIKE. */
function ilikeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Offset (local − UTC) en ms de `BUSINESS_TIMEZONE` para un instante dado.
 * Derivado de Intl para no hardcodear el −04:00 (y seguir correcto si
 * alguna vez la zona cambia).
 */
function businessTzOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant;
}

/**
 * Límites [desde, hasta) de un día de negocio `YYYY-MM-DD` en UTC, para
 * comparar contra `trips.departure_time`.
 *
 * Mismo criterio que `toBusinessDateString` del frontend: un viaje de las
 * 22:00 de Caracas (02:00 UTC del día siguiente) pertenece al día local.
 * Con UTC puro ese viaje se excluiría; aquí no. Caracas no tiene DST, así
 * que el offset del instante sirve para todo el día.
 *
 * Devuelve `null` si `date` no es un día real `YYYY-MM-DD`.
 */
function businessDayUtcBounds(date: string): { from: string; to: string } | null {
  if (!DATE_ONLY_RE.test(date)) return null;
  const probe = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(probe)) return null;

  const from = probe - businessTzOffsetMs(probe);
  return {
    from: new Date(from).toISOString(),
    to: new Date(from + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ── Showcase: viajes por agencia (1 query, usado por directorio y perfil) ──

interface AgencyShowcase {
  /** Viajes reservables hoy: active + is_published + salida futura. */
  publishedTripCount: number;
  /** Subconjunto de `allTripIds` reservable hoy (candidatos a listarse). */
  eligibleTripIds: string[];
  /** TODOS los ids de viaje de la agencia: base del promedio de viajes. */
  allTripIds: string[];
}

function emptyShowcase(): AgencyShowcase {
  return { publishedTripCount: 0, eligibleTripIds: [], allTripIds: [] };
}

/**
 * Una sola consulta `trip_agencies` con el viaje embebido resuelve, para
 * CADA agencia pedida:
 *   * cuántos viajes publicados/reservables hoy tiene (estadística),
 *   * qué viajes listar en el perfil (con los filtros del request),
 *   * qué viajes entran en la calificación de viajes (TODOS, incluidos los
 *     ya completados: justo ahí es donde existen las reseñas).
 *
 * La elegibilidad se calcula en JS para no necesitar un segundo query y
 * para que el conteo sin filtros y el listado filtrado compartan la misma
 * fuente de verdad.
 */
async function loadAgencyShowcase(agencyIds: string[]): Promise<Map<string, AgencyShowcase>> {
  const showcase = new Map<string, AgencyShowcase>();
  for (const id of agencyIds) showcase.set(id, emptyShowcase());
  if (agencyIds.length === 0) return showcase;

  const now = Date.now();
  const { data, error } = await supabaseAdmin
    .from('trip_agencies')
    .select('agency_id, trip_id, trips!inner(status, is_published, departure_time)')
    .in('agency_id', agencyIds);

  if (error) {
    throw new InternalError('AGENCY_SHOWCASE_QUERY_ERROR', error.message);
  }

  for (const row of (data ?? []) as unknown as Array<{
    agency_id: string;
    trip_id: string;
    trips: { status?: string; is_published?: boolean; departure_time?: string } | null;
  }>) {
    const entry = showcase.get(row.agency_id);
    if (!entry) continue;

    entry.allTripIds.push(row.trip_id);

    const trip = row.trips;
    const departure = trip?.departure_time ? Date.parse(trip.departure_time) : Number.NaN;
    const eligible =
      trip?.status === 'active' &&
      trip?.is_published === true &&
      !Number.isNaN(departure) &&
      departure >= now;

    if (eligible) {
      entry.publishedTripCount += 1;
      entry.eligibleTripIds.push(row.trip_id);
    }
  }

  return showcase;
}

// ── Calificaciones ──────────────────────────────────────────────────────────

/**
 * Calificaciones de las agencias pedidas, SIEMPRE separadas en `agency` y
 * `trip`. Las dos consultas corren en paralelo; si alguna tabla de reseñas
 * aún no existe (099 sin aplicar) esa mitad queda vacía sin romper el
 * endpoint.
 */
async function loadAgencyRatings(
  agencyIds: string[],
  showcaseByAgency: Map<string, AgencyShowcase>,
): Promise<Map<string, AgencyRatings>> {
  const ratings = new Map<string, AgencyRatings>();
  for (const id of agencyIds) {
    ratings.set(id, { agency: emptyRating(), trip: emptyRating() });
  }
  if (agencyIds.length === 0) return ratings;

  const allTripIds = [
    ...new Set(Array.from(showcaseByAgency.values()).flatMap((s) => s.allTripIds)),
  ];

  const [agencyReviews, tripReviews] = await Promise.all([
    supabaseAdmin
      .from('agency_reviews')
      .select('agency_id, rating')
      .eq('moderation_status', 'visible')
      .in('agency_id', agencyIds),
    allTripIds.length > 0
      ? supabaseAdmin
          .from('trip_reviews')
          .select('trip_id, rating')
          .eq('moderation_status', 'visible')
          .in('trip_id', allTripIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Un fallo REAL de base de datos nunca se silencia como "sin reseñas";
  // solo se tolera la ausencia de la propia relación (097-099 pendientes).
  if (agencyReviews.error && !isRelationMissing(agencyReviews.error)) {
    throw new InternalError('AGENCY_RATINGS_QUERY_ERROR', agencyReviews.error.message);
  }
  if (tripReviews.error && !isRelationMissing(tripReviews.error)) {
    throw new InternalError('AGENCY_RATINGS_QUERY_ERROR', tripReviews.error.message);
  }

  const agencySums = new Map<string, { sum: number; count: number }>();
  for (const row of (agencyReviews.data ?? []) as unknown as Array<{
    agency_id: string;
    rating: number;
  }>) {
    const acc = agencySums.get(row.agency_id) ?? { sum: 0, count: 0 };
    acc.sum += Number(row.rating);
    acc.count += 1;
    agencySums.set(row.agency_id, acc);
  }

  const tripSumsByTrip = new Map<string, { sum: number; count: number }>();
  for (const row of (tripReviews.data ?? []) as unknown as Array<{
    trip_id: string;
    rating: number;
  }>) {
    const acc = tripSumsByTrip.get(row.trip_id) ?? { sum: 0, count: 0 };
    acc.sum += Number(row.rating);
    acc.count += 1;
    tripSumsByTrip.set(row.trip_id, acc);
  }

  for (const [agencyId, entry] of showcaseByAgency) {
    let sum = 0;
    let count = 0;
    for (const tripId of entry.allTripIds) {
      const acc = tripSumsByTrip.get(tripId);
      if (!acc) continue;
      sum += acc.sum;
      count += acc.count;
    }
    ratings.set(agencyId, {
      agency: ratingFrom(agencySums.get(agencyId)?.sum ?? 0, agencySums.get(agencyId)?.count ?? 0),
      trip: ratingFrom(sum, count),
    });
  }

  return ratings;
}

// ── DTOs públicos ───────────────────────────────────────────────────────────

interface AgencyRow {
  id: string;
  name: string;
  subdomain: string;
  phone?: string | null;
  is_featured: boolean;
  featured_order: number;
  agency_settings: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    // Phase 7 — solo presentes en el select del perfil.
    cover_url?: string | null;
    slogan?: string | null;
    description?: string | null;
  } | null;
}

function mapAgencyBase(
  row: AgencyRow,
  ratings: AgencyRatings,
  publishedTrips: number,
): PublicAgencyDto {
  const settings = row.agency_settings ?? null;
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    logo_url: settings?.logo_url ?? null,
    primary_color: settings?.primary_color ?? null,
    secondary_color: settings?.secondary_color ?? null,
    accent_color: settings?.accent_color ?? null,
    is_featured: row.is_featured === true,
    featured_order: Number(row.featured_order ?? 0),
    ratings,
    published_trips_count: publishedTrips,
  };
}

// ── API del servicio ────────────────────────────────────────────────────────

export interface ListPublicAgenciesParams {
  limit: number;
  offset: number;
}

/**
 * GET /api/public/agencies — directorio público.
 *
 * Orden manual persistente: `is_featured DESC, featured_order ASC,
 * name ASC` (el desempate por nombre hace el orden total y estable).
 * Solo agencias `active`.
 */
export async function listPublicAgencies(
  params: ListPublicAgenciesParams,
): Promise<PublicAgencyListResult> {
  const { data, error, count } = await supabaseAdmin
    .from('agencies')
    .select(DIRECTORY_AGENCY_COLUMNS, { count: 'exact' })
    .eq('status', 'active')
    .order('is_featured', { ascending: false })
    .order('featured_order', { ascending: true })
    .order('name', { ascending: true })
    .range(params.offset, params.offset + params.limit - 1);

  if (error) {
    throw new InternalError('AGENCIES_QUERY_ERROR', error.message);
  }

  const rows = (data ?? []) as unknown as AgencyRow[];
  if (rows.length === 0) {
    return { agencies: [], total: count ?? 0 };
  }

  const agencyIds = rows.map((row) => row.id);
  const showcase = await loadAgencyShowcase(agencyIds);
  const ratings = await loadAgencyRatings(agencyIds, showcase);

  return {
    agencies: rows.map((row) =>
      mapAgencyBase(
        row,
        ratings.get(row.id) ?? { agency: emptyRating(), trip: emptyRating() },
        showcase.get(row.id)?.publishedTripCount ?? 0,
      ),
    ),
    total: count ?? rows.length,
  };
}

export interface GetPublicAgencyParams extends AgencyTripsFilters {
  agencyId: string;
  limit: number;
  offset: number;
}

/**
 * GET /api/public/agencies/:agencyId — perfil público.
 *
 * 404 `AGENCY_NOT_FOUND` si la agencia no existe o no está activa (el
 * directorio público nunca revela agencias inactivas). Los viajes se
 * filtran EN EL SERVIDOR (origin/destination por ILIKE sobre `routes`,
 * date por día de negocio America/Caracas) con la elegibilidad del
 * catálogo: active + is_published + salida futura.
 */
export async function getPublicAgency(
  params: GetPublicAgencyParams,
): Promise<{ agency: PublicAgencyProfileDto }> {
  // Formato y realidad de la fecha se validan ANTES de tocar la base: un
  // `?date=` inválido es 400 aunque no haya viajes que listar.
  const dateBounds = params.date ? businessDayUtcBounds(params.date) : null;
  if (params.date && !dateBounds) {
    throw new ValidationError('La fecha debe tener formato YYYY-MM-DD');
  }

  const { data: agencyRow, error: agencyError } = await supabaseAdmin
    .from('agencies')
    .select(PROFILE_AGENCY_COLUMNS)
    .eq('id', params.agencyId)
    .eq('status', 'active')
    .maybeSingle();

  if (agencyError) {
    throw new InternalError('AGENCY_QUERY_ERROR', agencyError.message);
  }
  if (!agencyRow) {
    throw new AppError('Agencia no encontrada', 404, 'AGENCY_NOT_FOUND');
  }

  const agencyId = (agencyRow as unknown as AgencyRow).id;

  const [contactsResult, showcase] = await Promise.all([
    supabaseAdmin
      .from('agency_contacts')
      .select('id, label, phone, channel')
      .eq('agency_id', agencyId)
      // Los tres filtros definen lo publicable (091); el orden lo decide
      // la agencia (sort_order y luego created_at).
      .eq('is_public', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    loadAgencyShowcase([agencyId]),
  ]);

  // 091 es dependencia dura (ya aplicada): un fallo real no se silencia.
  if (contactsResult.error) {
    throw new InternalError('AGENCY_CONTACTS_QUERY_ERROR', contactsResult.error.message);
  }

  const entry = showcase.get(agencyId) ?? emptyShowcase();

  const [ratings, tripsPage] = await Promise.all([
    loadAgencyRatings([agencyId], showcase),
    loadAgencyTrips(entry.eligibleTripIds, params, dateBounds),
  ]);

  const base = mapAgencyBase(
    agencyRow as unknown as AgencyRow,
    ratings.get(agencyId) ?? { agency: emptyRating(), trip: emptyRating() },
    entry.publishedTripCount,
  );

  const settings = (agencyRow as unknown as AgencyRow).agency_settings;

  return {
    agency: {
      ...base,
      phone: (agencyRow as unknown as AgencyRow).phone ?? null,
      cover_url: settings?.cover_url ?? null,
      slogan: settings?.slogan ?? null,
      description: settings?.description ?? null,
      contacts: ((contactsResult.data ?? []) as unknown as PublicAgencyContactRow[]).map(
        mapPublicAgencyContact,
      ),
      trips: tripsPage.trips,
      trips_total: tripsPage.total,
    },
  };
}

/**
 * Página de viajes del perfil, filtrada en el servidor.
 *
 * Los ids ya vienen elegibles desde `loadAgencyShowcase` (active +
 * is_published + salida futura), así que aquí solo se aplican los filtros
 * del usuario, el orden y la paginación. `routes!inner` permite filtrar
 * origin/destination sobre el padre sin N+1.
 */
async function loadAgencyTrips(
  eligibleTripIds: string[],
  params: GetPublicAgencyParams,
  dateBounds: { from: string; to: string } | null,
): Promise<{ trips: PublicTripListItemDto[]; total: number }> {
  if (eligibleTripIds.length === 0) {
    return { trips: [], total: 0 };
  }

  let query = supabaseAdmin
    .from('trips')
    .select(AGENCY_TRIP_COLUMNS, { count: 'exact' })
    .in('id', eligibleTripIds);

  if (params.origin) {
    query = query.ilike('routes.origin', ilikeContains(params.origin));
  }
  if (params.destination) {
    query = query.ilike('routes.destination', ilikeContains(params.destination));
  }
  if (dateBounds) {
    query = query.gte('departure_time', dateBounds.from).lt('departure_time', dateBounds.to);
  }

  const { data, error, count } = await query
    .order('departure_time', { ascending: true })
    .range(params.offset, params.offset + params.limit - 1);

  if (error) {
    throw new InternalError('AGENCY_TRIPS_QUERY_ERROR', error.message);
  }

  return {
    trips: ((data ?? []) as unknown as any[]).map(mapPublicTripRow),
    total: count ?? 0,
  };
}

// ── Superadmin: destacado y orden ───────────────────────────────────────────

export interface AdminAgencyShowcaseDto {
  id: string;
  name: string;
  subdomain: string;
  is_featured: boolean;
  featured_order: number;
}

export interface AdminUpdateAgencyInput {
  agencyId: string;
  isFeatured?: boolean | undefined;
  featuredOrder?: number | undefined;
}

/**
 * PATCH /api/admin/agencies/:agencyId — solo superadmin (la autorización
 * vive en la ruta).
 *
 * Reglas:
 *   * el body debe traer `is_featured` y/o `featured_order`;
 *   * al destacar sin orden, el orden se conserva (una agencia no
 *     destacada siempre tiene 0, porque al quitar el destacado se resetea);
 *   * al QUITAR el destacado el orden se resetea a 0: no queda un valor
 *     huérfano en la posición del directorio;
 *   * una agencia no destacada no puede recibir orden > 0 (400).
 *
 * UPDATE de una sola pasada con `select`: si no hay fila, 404.
 */
export async function adminUpdateAgencyShowcase(
  input: AdminUpdateAgencyInput,
): Promise<{ agency: AdminAgencyShowcaseDto }> {
  const payload: Record<string, unknown> = {};

  if (input.isFeatured !== undefined) {
    payload.is_featured = input.isFeatured;
    if (!input.isFeatured) payload.featured_order = 0;
  }

  if (input.featuredOrder !== undefined) {
    if (input.isFeatured === false && input.featuredOrder !== 0) {
      throw new ValidationError(
        'Una agencia no destacada no puede tener orden de exhibición',
      );
    }
    payload.featured_order = input.featuredOrder;
  }

  if (Object.keys(payload).length === 0) {
    throw new ValidationError('Debe indicar is_featured y/o featured_order');
  }

  const { data, error } = await supabaseAdmin
    .from('agencies')
    .update(payload)
    .eq('id', input.agencyId)
    .select('id, name, subdomain, is_featured, featured_order')
    .maybeSingle();

  if (error) {
    throw new InternalError('AGENCY_UPDATE_ERROR', error.message);
  }
  if (!data) {
    throw new AppError('Agencia no encontrada', 404, 'AGENCY_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string;
    name: string;
    subdomain: string;
    is_featured: boolean;
    featured_order: number;
  };

  return {
    agency: {
      id: row.id,
      name: row.name,
      subdomain: row.subdomain,
      is_featured: row.is_featured === true,
      featured_order: Number(row.featured_order ?? 0),
    },
  };
}
