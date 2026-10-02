import { Router } from 'express';
import { supabaseAdmin } from '../../config/database.js';
import { AppError } from '../../errors/index.js';
import { env } from '../../config/env.js';

const router = Router();

/**
 * GET /api/public/trips
 * Catálogo público de viajes activos (solo lectura, sin PII).
 * Query: origin, destination, date (YYYY-MM-DD)
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('trips')
      .select('id, departure_time, capacity, vehicle_type, status, routes(origin, destination)')
      .eq('status', 'active')
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

export default router;
