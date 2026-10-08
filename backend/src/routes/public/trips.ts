import { Router } from 'express';
import { supabaseAdmin } from '../../config/database.js';
import { AppError } from '../../errors/index.js';
import { env } from '../../config/env.js';

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      .select('id, departure_time, capacity, vehicle_type, status, routes(origin, destination)')
      .eq('status', 'active')
      .gte('departure_time', new Date().toISOString())
      .order('departure_time', { ascending: true })
      .limit(100);

    if (error) {
      throw new AppError(error.message, 500, 'TRIPS_QUERY_ERROR');
    }

    const trips = (data ?? []).map((row: any) => ({
      id: row.id,
      departure_time: row.departure_time,
      capacity: row.capacity,
      vehicle_type: row.vehicle_type,
      status: row.status,
      route: row.routes ?? { origin: '', destination: '' },
      lock_ttl_seconds: env.LOCK_TTL_SECONDS,
    }));

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
      throw new AppError(error.message, 500, 'TRIP_QUERY_ERROR');
    }
    if (!trip) {
      throw new AppError('Viaje no encontrado', 404, 'TRIP_NOT_FOUND');
    }

    const [offersResult, seatsResult] = await Promise.all([
      supabaseAdmin
        .from('trip_agencies')
        .select(
          'agency_id, agencies!inner(id, name, status, agency_settings(logo_url, primary_color, secondary_color, accent_color))',
        )
        .eq('trip_id', id)
        .eq('agencies.status', 'active'),
      supabaseAdmin.from('seats').select('id, seat_code, status').eq('trip_id', id),
    ]);

    if (offersResult.error) {
      throw new AppError(offersResult.error.message, 500, 'TRIP_OFFERS_QUERY_ERROR');
    }
    if (seatsResult.error) {
      throw new AppError(seatsResult.error.message, 500, 'TRIP_SEATS_QUERY_ERROR');
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
