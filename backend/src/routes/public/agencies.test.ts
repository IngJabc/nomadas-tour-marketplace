import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.JWT_SECRET = 'test-jwt-secret-for-app-tests';
  process.env.CORS_ORIGIN = 'http://localhost:3002';
  process.env.RESEND_API_KEY = 'test-resend';
  process.env.EMAIL_FROM = 'test@example.com';
  process.env.FRONTEND_URL = 'http://localhost:3002';
});

// Mock por TABLA (no por orden): los endpoints disparan consultas en
// paralelo (Promise.all), así que una cola secuencial sería frágil.
const harness = vi.hoisted(() => {
  type QueryResult = {
    data?: any;
    error?: { code?: string; message?: string } | null;
    count?: number | null;
  };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: Array<{ table: string; calls: Array<{ method: string; args: any[] }> }>;
  } = { queues: {}, defaults: {}, chains: [] };

  const METHODS = [
    'select',
    'update',
    'insert',
    'upsert',
    'delete',
    'eq',
    'neq',
    'in',
    'is',
    'lt',
    'lte',
    'gt',
    'gte',
    'ilike',
    'order',
    'range',
    'limit',
    'maybeSingle',
    'single',
  ];

  function buildChain(table: string) {
    const record = { table, calls: [] as Array<{ method: string; args: any[] }> };
    state.chains.push(record);
    const chain: Record<string, any> = {};
    for (const method of METHODS) {
      chain[method] = (...args: any[]) => {
        record.calls.push({ method, args });
        return chain;
      };
    }
    chain.then = (onFulfilled: any, onRejected: any) => {
      const queue = state.queues[table];
      const result =
        queue && queue.length > 0
          ? queue.shift()!
          : state.defaults[table] ?? { data: null, error: null };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };
    return chain;
  }

  return {
    push(table: string, result: QueryResult) {
      (state.queues[table] ||= []).push(result);
    },
    setDefault(table: string, result: QueryResult) {
      state.defaults[table] = result;
    },
    callsFor(table: string) {
      return state.chains
        .filter((chain) => chain.table === table)
        .flatMap((chain) => chain.calls);
    },
    tablesQueried() {
      return state.chains.map((chain) => chain.table);
    },
    reset() {
      state.queues = {};
      state.defaults = {};
      state.chains = [];
    },
    from: (table: string) => buildChain(table),
    rpc: vi.fn(),
    auth: { getUser: vi.fn() },
    storage: { from: vi.fn() },
  };
});

vi.mock('../../config/database.js', () => ({
  supabase: harness,
  supabaseAdmin: harness,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const AGENCY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENCY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRIP_FUTURE = '11111111-1111-4111-8111-111111111111';
const TRIP_PAST = '22222222-2222-4222-8222-222222222222';
const TRIP_CANCELLED = '33333333-3333-4333-8333-333333333333';

const FUTURE = '2099-01-01T11:00:00.000Z';
const PAST = '2020-01-01T11:00:00.000Z';

function agencyRow(id: string, name: string, subdomain: string, featured = false, order = 0) {
  return {
    id,
    name,
    subdomain,
    is_featured: featured,
    featured_order: order,
    agency_settings: {
      logo_url: 'https://cdn.example.com/logo.png',
      primary_color: '#000024',
      secondary_color: '#0080FF',
      accent_color: '#00D4FF',
      // Phase 7: el directorio las recibe de la base pero NO las expone.
      cover_url: 'https://cdn.example.com/cover.png',
      slogan: 'Viaja seguro',
      description: 'Tours privados en la costa.',
    },
  };
}

function link(agencyId: string, tripId: string, trip: Record<string, unknown>) {
  return { agency_id: agencyId, trip_id: tripId, trips: trip };
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function requestJson(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let server: Server | null = null;
let port = 0;

beforeAll(async () => {
  server = await startServer();
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!server) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve, reject) => {
    closing.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  harness.reset();
});

describe('GET /api/public/agencies — directorio público (REP-001)', () => {
  it('ordena por destacado, orden manual y nombre, con calificaciones separadas', async () => {
    harness.push('agencies', {
      data: [
        agencyRow(AGENCY_A, 'Zeta Tours', 'zeta', true, 1),
        agencyRow(AGENCY_B, 'Alfa Viajes', 'alfa'),
      ],
      count: 2,
      error: null,
    });
    harness.push('trip_agencies', {
      data: [
        // Reservable hoy → cuenta en la estadística.
        link(AGENCY_A, TRIP_FUTURE, {
          status: 'active',
          is_published: true,
          departure_time: FUTURE,
        }),
        // Ya salió → NO cuenta, pero SUS reseñas sí puntúan.
        link(AGENCY_A, TRIP_PAST, {
          status: 'active',
          is_published: true,
          departure_time: PAST,
        }),
        // Cancelado → no cuenta.
        link(AGENCY_A, TRIP_CANCELLED, {
          status: 'cancelled',
          is_published: true,
          departure_time: FUTURE,
        }),
      ],
      error: null,
    });
    harness.push('agency_reviews', {
      data: [
        { agency_id: AGENCY_A, rating: 5 },
        { agency_id: AGENCY_A, rating: 4 },
      ],
      error: null,
    });
    harness.push('trip_reviews', {
      data: [
        { trip_id: TRIP_FUTURE, rating: 5 },
        { trip_id: TRIP_PAST, rating: 1 },
      ],
      error: null,
    });

    const res = await requestJson(port, '/api/public/agencies');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.agencies.map((agency: any) => agency.id)).toEqual([
      AGENCY_A,
      AGENCY_B,
    ]);

    const first = res.body.agencies[0];
    expect(first.is_featured).toBe(true);
    expect(first.featured_order).toBe(1);
    // Calificaciones SIEMPRE separadas; jamás un promedio combinado.
    expect(first.ratings).toEqual({
      agency: { average: 4.5, count: 2 },
      trip: { average: 3, count: 2 },
    });
    // Solo el viaje reservable: ni el pasado ni el cancelado cuentan.
    expect(first.published_trips_count).toBe(1);
    expect(first.logo_url).toBe('https://cdn.example.com/logo.png');
    expect(first.primary_color).toBe('#000024');

    // Phase 7: la presentación del storefront es SOLO del perfil.
    expect(first).not.toHaveProperty('cover_url');
    expect(first).not.toHaveProperty('slogan');
    expect(first).not.toHaveProperty('description');
    const directorySelect = harness
      .callsFor('agencies')
      .find((call) => call.method === 'select');
    expect(String(directorySelect?.args[0])).not.toContain('cover_url');

    const second = res.body.agencies[1];
    expect(second.is_featured).toBe(false);
    expect(second.ratings).toEqual({
      agency: { average: null, count: 0 },
      trip: { average: null, count: 0 },
    });
    expect(second.published_trips_count).toBe(0);

    // Orden del directorio, exactamente como lo define la migración 102.
    const orderCalls = harness
      .callsFor('agencies')
      .filter((call) => call.method === 'order')
      .map((call) => call.args);
    expect(orderCalls).toEqual([
      ['is_featured', { ascending: false }],
      ['featured_order', { ascending: true }],
      ['name', { ascending: true }],
    ]);
    expect(
      harness
        .callsFor('agencies')
        .filter((call) => call.method === 'eq')
        .map((call) => call.args),
    ).toEqual([['status', 'active']]);
  });

  it('sin agencias devuelve la lista vacía sin disparar consultas secundarias', async () => {
    harness.push('agencies', { data: [], count: 0, error: null });

    const res = await requestJson(port, '/api/public/agencies');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agencies: [], total: 0 });
    expect(harness.tablesQueried()).toEqual(['agencies']);
  });

  it('tolera las tablas de reseñas ausentes (097-099 sin aplicar) sin fallar', async () => {
    harness.push('agencies', {
      data: [agencyRow(AGENCY_A, 'Zeta Tours', 'zeta')],
      count: 1,
      error: null,
    });
    harness.push('trip_agencies', {
      data: [
        link(AGENCY_A, TRIP_FUTURE, {
          status: 'active',
          is_published: true,
          departure_time: FUTURE,
        }),
      ],
      error: null,
    });
    harness.push('agency_reviews', {
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.agency_reviews' in the schema cache",
      },
    });
    harness.push('trip_reviews', {
      data: null,
      error: { message: 'relation "public.trip_reviews" does not exist' },
    });

    const res = await requestJson(port, '/api/public/agencies');

    expect(res.status).toBe(200);
    expect(res.body.agencies[0].ratings).toEqual({
      agency: { average: null, count: 0 },
      trip: { average: null, count: 0 },
    });
    expect(res.body.agencies[0].published_trips_count).toBe(1);
  });

  it('responde 500 ante un fallo REAL de la consulta de reseñas', async () => {
    harness.push('agencies', {
      data: [agencyRow(AGENCY_A, 'Zeta Tours', 'zeta')],
      count: 1,
      error: null,
    });
    harness.push('trip_agencies', { data: [], error: null });
    harness.push('agency_reviews', {
      data: null,
      error: { message: 'permission denied for table agency_reviews' },
    });

    const res = await requestJson(port, '/api/public/agencies');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AGENCY_RATINGS_QUERY_ERROR');
  });

  it('valida limit y offset', async () => {
    const tooBig = await requestJson(port, '/api/public/agencies?limit=999');
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('VALIDATION_ERROR');

    const negative = await requestJson(port, '/api/public/agencies?offset=-1');
    expect(negative.status).toBe(400);
    expect(harness.tablesQueried()).toEqual([]);
  });

  it('no expone datos privados de la agencia en el directorio', async () => {
    harness.push('agencies', {
      data: [agencyRow(AGENCY_A, 'Zeta Tours', 'zeta')],
      count: 1,
      error: null,
    });
    harness.push('trip_agencies', { data: [], error: null });
    harness.push('agency_reviews', { data: [], error: null });

    const res = await requestJson(port, '/api/public/agencies');

    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('email');
    expect(raw).not.toContain('phone');
    expect(raw).not.toContain('payment');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('customers');
  });
});

describe('GET /api/public/agencies/:agencyId — perfil público (REP-001)', () => {
  function givenProfile(options: { trips?: any[]; tripCount?: number } = {}) {
    harness.push('agencies', {
      data: {
        id: AGENCY_A,
        name: 'Zeta Tours',
        subdomain: 'zeta',
        phone: '04121234567',
        is_featured: true,
        featured_order: 2,
        agency_settings: {
          logo_url: 'https://cdn.example.com/logo.png',
          primary_color: '#000024',
          secondary_color: '#0080FF',
          accent_color: '#00D4FF',
          cover_url: 'https://cdn.example.com/cover.png',
          slogan: 'Viaja seguro',
          description: 'Tours privados en la costa.',
        },
      },
      error: null,
    });
    harness.push('agency_contacts', {
      data: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          label: 'WhatsApp',
          phone: '+584121234567',
          channel: 'whatsapp',
        },
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          label: 'Oficina',
          phone: '+582125551234',
          channel: 'call',
        },
      ],
      error: null,
    });
    harness.push('trip_agencies', {
      data: [
        link(AGENCY_A, TRIP_FUTURE, {
          status: 'active',
          is_published: true,
          departure_time: FUTURE,
        }),
        link(AGENCY_A, TRIP_PAST, {
          status: 'active',
          is_published: true,
          departure_time: PAST,
        }),
      ],
      error: null,
    });
    harness.push('agency_reviews', {
      data: [{ agency_id: AGENCY_A, rating: 4 }],
      error: null,
    });
    harness.push('trip_reviews', {
      data: [{ trip_id: TRIP_FUTURE, rating: 5 }],
      error: null,
    });
    if (options.trips !== undefined) {
      harness.push('trips', {
        data: options.trips,
        count: options.tripCount ?? options.trips.length,
        error: null,
      });
    }
  }

  const catalogTrip = {
    id: TRIP_FUTURE,
    departure_time: FUTURE,
    capacity: 31,
    vehicle_type: 'bus',
    status: 'active',
    seat_price: 2000,
    routes: { origin: 'Caracas', destination: 'Maracaibo' },
    trip_agencies: [
      {
        agency_id: AGENCY_A,
        agencies: { id: AGENCY_A, name: 'Zeta Tours', status: 'active' },
      },
    ],
    seats: [{ status: 'available' }, { status: 'reserved' }, { status: 'available' }],
  };

  it('devuelve identidad, branding, contactos públicos y viajes', async () => {
    givenProfile({ trips: [catalogTrip] });

    const res = await requestJson(port, `/api/public/agencies/${AGENCY_A}`);

    expect(res.status).toBe(200);
    const agency = res.body.agency;
    expect(agency.id).toBe(AGENCY_A);
    expect(agency.name).toBe('Zeta Tours');
    expect(agency.subdomain).toBe('zeta');
    expect(agency.phone).toBe('04121234567');
    expect(agency.logo_url).toBe('https://cdn.example.com/logo.png');
    expect(agency.is_featured).toBe(true);
    expect(agency.featured_order).toBe(2);

    // Phase 7 — presentación del storefront en el perfil público.
    expect(agency.cover_url).toBe('https://cdn.example.com/cover.png');
    expect(agency.slogan).toBe('Viaja seguro');
    expect(agency.description).toBe('Tours privados en la costa.');
    const profileSelect = harness
      .callsFor('agencies')
      .find((call) => call.method === 'select');
    expect(String(profileSelect?.args[0])).toContain('cover_url');

    // Contactos públicos (091) mapeados al DTO público.
    expect(agency.contacts).toEqual([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        label: 'WhatsApp',
        phone: '+584121234567',
        channel: 'whatsapp',
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        label: 'Oficina',
        phone: '+582125551234',
        channel: 'call',
      },
    ]);

    // Estadística sin filtros: solo el viaje reservable.
    expect(agency.published_trips_count).toBe(1);
    expect(agency.trips_total).toBe(1);
    expect(agency.trips).toHaveLength(1);
    expect(agency.trips[0].route).toEqual({
      origin: 'Caracas',
      destination: 'Maracaibo',
    });
    expect(agency.trips[0].available_seats).toBe(2);
    expect(agency.trips[0].lock_ttl_seconds).toBeTypeOf('number');

    // Calificaciones separadas (nunca combinadas).
    expect(agency.ratings).toEqual({
      agency: { average: 4, count: 1 },
      trip: { average: 5, count: 1 },
    });

    // El email de acceso y los métodos de pago jamás salen.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('email');
    expect(raw).not.toContain('payment');
    expect(raw).not.toContain('password');
  });

  it('filtra los viajes en el servidor por origin, destination y date', async () => {
    givenProfile({ trips: [catalogTrip] });

    const res = await requestJson(
      port,
      `/api/public/agencies/${AGENCY_A}?origin=caracas&destination=Maracaibo&date=2099-01-01`,
    );

    expect(res.status).toBe(200);

    const tripCalls = harness.callsFor('trips');
    expect(tripCalls.find((call) => call.method === 'in')?.args).toEqual([
      'id',
      [TRIP_FUTURE],
    ]);

    const ilikes = tripCalls
      .filter((call) => call.method === 'ilike')
      .map((call) => call.args);
    expect(ilikes).toEqual([
      ['routes.origin', '%caracas%'],
      ['routes.destination', '%Maracaibo%'],
    ]);

    // Día de negocio America/Caracas: 2099-01-01 local = [04:00Z, 04:00Z+1d).
    expect(tripCalls.find((call) => call.method === 'gte')?.args).toEqual([
      'departure_time',
      '2099-01-01T04:00:00.000Z',
    ]);
    expect(tripCalls.find((call) => call.method === 'lt')?.args).toEqual([
      'departure_time',
      '2099-01-02T04:00:00.000Z',
    ]);
  });

  it('responde 400 cuando la fecha no es un día YYYY-MM-DD válido', async () => {
    const res = await requestJson(
      port,
      `/api/public/agencies/${AGENCY_A}?date=01-01-2099`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Se valida antes de tocar la base de datos.
    expect(harness.tablesQueried()).toEqual([]);
  });

  it('responde 404 AGENCY_NOT_FOUND cuando el id no es un UUID', async () => {
    const res = await requestJson(port, '/api/public/agencies/no-es-uuid');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AGENCY_NOT_FOUND');
    expect(harness.tablesQueried()).toEqual([]);
  });

  it('responde 404 AGENCY_NOT_FOUND cuando la agencia no existe o no está activa', async () => {
    harness.push('agencies', { data: null, error: null });

    const res = await requestJson(port, `/api/public/agencies/${AGENCY_A}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AGENCY_NOT_FOUND');
  });

  it('devuelve trips vacío sin consultar la tabla trips cuando no hay viajes', async () => {
    harness.push('agencies', {
      data: {
        id: AGENCY_A,
        name: 'Zeta Tours',
        subdomain: 'zeta',
        phone: null,
        is_featured: false,
        featured_order: 0,
        agency_settings: null,
      },
      error: null,
    });
    harness.push('agency_contacts', { data: [], error: null });
    harness.push('trip_agencies', { data: [], error: null });
    harness.push('agency_reviews', { data: [], error: null });

    const res = await requestJson(port, `/api/public/agencies/${AGENCY_A}`);

    expect(res.status).toBe(200);
    expect(res.body.agency.trips).toEqual([]);
    expect(res.body.agency.trips_total).toBe(0);
    expect(res.body.agency.published_trips_count).toBe(0);
    expect(res.body.agency.contacts).toEqual([]);
    expect(res.body.agency.phone).toBeNull();
    expect(harness.tablesQueried()).not.toContain('trips');
    expect(harness.tablesQueried()).not.toContain('trip_reviews');
  });

  it('responde 500 cuando falla la consulta de contactos públicos', async () => {
    harness.push('agencies', {
      data: {
        id: AGENCY_A,
        name: 'Zeta Tours',
        subdomain: 'zeta',
        phone: null,
        is_featured: false,
        featured_order: 0,
        agency_settings: null,
      },
      error: null,
    });
    harness.push('agency_contacts', {
      data: null,
      error: { message: 'permission denied for table agency_contacts' },
    });

    const res = await requestJson(port, `/api/public/agencies/${AGENCY_A}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AGENCY_CONTACTS_QUERY_ERROR');
  });
});
