import { Router } from 'express';
import { supabaseAdmin } from '../../config/database.js';
import { AppError, InternalError } from '../../errors/index.js';
import { env } from '../../config/env.js';

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MKT-008: contacto público de agencia (tabla 091 agency_contacts). Solo
// se publican contactos con is_public=true, is_active=true y
// deleted_at IS NULL; el teléfono es E.164 por CHECK de la migración.
interface PublicAgencyContactDto {
  id: string;
  label: string;
  phone: string;
  channel: 'call' | 'whatsapp';
}

/**
 * GET /api/public/trips
 * Catálogo público de viajes activos y aún no departidos (solo lectura,
 * sin PII). Un viaje cuya salida ya pasó no es reservable, así que no se
 * lista.
 * Query: origin, destination, date (YYYY-MM-DD)
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('trips')
      .select(
        // seats(status) es un embed del MISMO query: el catálogo expone la
        // disponibilidad real por viaje sin N+1 (un viaje con 31 asientos
        // no dispara 31 consultas).
        'id, departure_time, capacity, vehicle_type, status, seat_price, routes(origin, destination), trip_agencies(agency_id, agencies(id, name, status)), seats(status)',
      )
      .eq('status', 'active')
      .gte('departure_time', new Date().toISOString())
      .order('departure_time', { ascending: true })
      .limit(100);

    if (error) {
      throw new InternalError('TRIPS_QUERY_ERROR', error.message);
    }

    const trips = (data ?? []).map((row: any) => {
      // Embed izquierdo (sin !inner): un viaje sin agencias se lista con la
      // colección vacía, nunca se cae del catálogo. Un solo query, sin N+1.
      const agencies = ((row.trip_agencies ?? []) as Array<any>)
        .map((link) => link.agencies)
        .filter((agency: any) => agency?.status === 'active')
        .map((agency: any) => ({ id: agency.id, name: agency.name ?? '' }))
        // Orden estable y determinista (sin depender de locale del runtime).
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      // Disponibilidad REAL: solo los asientos en estado 'available' (los
      // reservados, bloqueados, con lock o la guía no cuentan como libres).
      const availableSeats = ((row.seats ?? []) as Array<any>).filter(
        (seat: any) => seat?.status === 'available',
      ).length;
      return {
        id: row.id,
        departure_time: row.departure_time,
        capacity: row.capacity,
        vehicle_type: row.vehicle_type,
        status: row.status,
        seat_price: row.seat_price ?? null,
        route: row.routes ?? { origin: '', destination: '' },
        lock_ttl_seconds: env.LOCK_TTL_SECONDS,
        agencies,
        available_seats: availableSeats,
      };
    });

    res.json({ trips });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/trips/:id
 * Detalle público de un viaje activo: ruta, precio, agencias (ofertas)
 * con branding y mapa real de asientos + disponibilidad. Sin PII.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    if (!UUID_RE.test(id)) {
      throw new AppError('Viaje no encontrado', 404, 'TRIP_NOT_FOUND');
    }

    const { data: trip, error } = await supabaseAdmin
      .from('trips')
      .select(
        'id, departure_time, capacity, vehicle_type, status, seat_price, installment_allowed, installment_amount_cents, routes(origin, destination)',
      )
      .eq('id', id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      throw new InternalError('TRIP_QUERY_ERROR', error.message);
    }
    if (!trip) {
      throw new AppError('Viaje no encontrado', 404, 'TRIP_NOT_FOUND');
    }

    const [offersResult, seatsResult] = await Promise.all([
      supabaseAdmin
        .from('trip_agencies')
        .select(
          'agency_id, agencies!inner(id, name, status, phone, agency_settings(logo_url, primary_color, secondary_color, accent_color))',
        )
        .eq('trip_id', id)
        .eq('agencies.status', 'active')
        // Orden determinista: sin ORDER BY el orden de `offers[]` lo decide
        // el planificador de la base de datos y cambia tras cada
        // DELETE+INSERT de `update_trip` (084). `agency_id` es único por
        // viaje (UNIQUE(trip_id, agency_id) de 011), así que sirve de criterio
        // estable de desempate y de orden total a la vez.
        .order('agency_id', { ascending: true }),
      supabaseAdmin.from('seats').select('id, seat_code, status').eq('trip_id', id),
    ]);

    if (offersResult.error) {
      throw new InternalError('TRIP_OFFERS_QUERY_ERROR', offersResult.error.message);
    }
    if (seatsResult.error) {
      throw new InternalError('TRIP_SEATS_QUERY_ERROR', seatsResult.error.message);
    }

    // MKT-007.4: agencias de ESTE viaje con al menos un canal de pago
    // activo. Se resuelve por los agency_id de las ofertas; jamas se
    // acepta un filtro del cliente.
    const offerAgencyIds = (offersResult.data ?? []).map((row: any) => row.agency_id);
    let agenciesWithMethods = new Set<string>();
    const contactsByAgency = new Map<string, PublicAgencyContactDto[]>();
    if (offerAgencyIds.length > 0) {
      const [methodsResult, contactsResult] = await Promise.all([
        supabaseAdmin
          .from('agency_payment_methods')
          .select('agency_id')
          // Solo metodos soportados por el checkout (hoy: pago_movil).
          .eq('method', 'pago_movil')
          .eq('is_active', true)
          .is('deleted_at', null)
          .in('agency_id', offerAgencyIds),
        // MKT-008: contactos públicos de las agencias del viaje. Los tres
        // filtros (is_public, is_active, deleted_at) definen lo publicable;
        // el orden lo decide la agencia (sort_order y luego created_at).
        // El filtro va SIEMPRE por los agency_id de las ofertas: el
        // cliente nunca determina qué agencia se consulta.
        supabaseAdmin
          .from('agency_contacts')
          .select('id, agency_id, label, phone, channel')
          .in('agency_id', offerAgencyIds)
          .eq('is_public', true)
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true }),
      ]);

      if (methodsResult.error) {
        throw new InternalError('TRIP_OFFERS_QUERY_ERROR', methodsResult.error.message);
      }
      // Un fallo real de base de datos NO se silencia como "sin contactos".
      if (contactsResult.error) {
        throw new InternalError('TRIP_OFFERS_QUERY_ERROR', contactsResult.error.message);
      }
      agenciesWithMethods = new Set(
        (methodsResult.data ?? []).map((row: any) => String(row.agency_id)),
      );
      for (const row of (contactsResult.data ?? []) as Array<{
        id: unknown;
        agency_id: unknown;
        label: unknown;
        phone: unknown;
        channel: unknown;
      }>) {
        const agencyKey = String(row.agency_id);
        const list = contactsByAgency.get(agencyKey) ?? [];
        list.push({
          id: String(row.id),
          label: String(row.label),
          phone: String(row.phone),
          channel: row.channel === 'call' ? 'call' : 'whatsapp',
        });
        contactsByAgency.set(agencyKey, list);
      }
    }

    const offers = (offersResult.data ?? []).map((row: any) => {
      const agency = row.agencies ?? {};
      const settings = agency.agency_settings ?? null;
      return {
        agency_id: row.agency_id,
        name: agency.name ?? '',
        logo_url: settings?.logo_url ?? null,
        primary_color: settings?.primary_color ?? null,
        secondary_color: settings?.secondary_color ?? null,
        accent_color: settings?.accent_color ?? null,
        // MKT-007.4: teléfono público de la agencia (aviso WhatsApp)
        // y si la agencia ya tiene canales de pago configurados.
        phone: agency.phone ?? null,
        payment_methods_available: agenciesWithMethods.has(String(row.agency_id)),
        // MKT-008: contactos públicos de ESTA agencia (vacío si no hay).
        contacts: contactsByAgency.get(String(row.agency_id)) ?? [],
      };
    });

    const seats = (seatsResult.data ?? []).map((row: any) => ({
      id: row.id,
      seat_code: row.seat_code,
      status: row.status,
    }));

    const availability = {
      total: seats.length,
      available: 0,
      reserved: 0,
      locked: 0,
      blocked: 0,
      guide: 0,
    };
    const countedStatuses = [
      'available',
      'reserved',
      'locked',
      'blocked',
      'guide',
    ] as const;
    for (const seat of seats) {
      if ((countedStatuses as readonly string[]).includes(seat.status)) {
        availability[seat.status as (typeof countedStatuses)[number]] += 1;
      }
    }

    res.json({
      trip: {
        id: trip.id,
        departure_time: trip.departure_time,
        capacity: trip.capacity,
        vehicle_type: trip.vehicle_type,
        status: trip.status,
        route: trip.routes ?? { origin: '', destination: '' },
        seat_price: trip.seat_price ?? null,
        installment_allowed: trip.installment_allowed ?? false,
        installment_amount_cents: trip.installment_amount_cents ?? null,
        lock_ttl_seconds: env.LOCK_TTL_SECONDS,
        offers,
        seats,
        availability,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
