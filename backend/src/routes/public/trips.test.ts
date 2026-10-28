import { afterEach, describe, expect, it, vi } from 'vitest';
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

const supabaseMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../config/database.js', () => ({
  supabase: supabaseMock,
  supabaseAdmin: supabaseMock,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';

type QueryResult = { data?: unknown; error?: { message: string } | null };

function queryChain(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select',
    'eq',
    'gte',
    'order',
    'limit',
    'maybeSingle',
    'in',
    'is',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    gte: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    in: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    then: typeof chain.then;
  };
}

function givenQueries(
  trips: QueryResult,
  offers?: QueryResult,
  seats?: QueryResult,
  paymentMethods?: QueryResult,
  contacts?: QueryResult,
) {
  supabaseMock.from.mockReturnValueOnce(queryChain(trips));
  if (offers) supabaseMock.from.mockReturnValueOnce(queryChain(offers));
  if (seats) supabaseMock.from.mockReturnValueOnce(queryChain(seats));
  if (paymentMethods)
    supabaseMock.from.mockReturnValueOnce(queryChain(paymentMethods));
  if (contacts) supabaseMock.from.mockReturnValueOnce(queryChain(contacts));
}

describe('GET /api/public/trips/:id (MKT-003)', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function startServer(): Promise<number> {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    return (server.address() as AddressInfo).port;
  }

  it('devuelve el detalle completo con ofertas, asientos y disponibilidad', async () => {
    givenQueries(
      {
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 31,
          vehicle_type: 'bus',
          status: 'active',
          seat_price: 2020,
          installment_allowed: true,
          installment_amount_cents: 1000,
          routes: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
        },
        error: null,
      },
      {
        data: [
          {
            agency_id: 'ag-1',
            agencies: {
              id: 'ag-1',
              name: 'Agencia Central',
              status: 'active',
              phone: '04121234567',
              agency_settings: {
                logo_url: 'https://cdn.example.com/logo.png',
                primary_color: '#000024',
                secondary_color: '#0080FF',
                accent_color: '#00D4FF',
              },
            },
          },
          {
            agency_id: 'ag-2',
            agencies: {
              id: 'ag-2',
              name: 'Rutas del Sol',
              status: 'active',
              phone: null,
              agency_settings: null,
            },
          },
        ],
        error: null,
      },
      {
        data: [
          { id: 's-1', seat_code: 'A1', status: 'available' },
          { id: 's-2', seat_code: 'A2', status: 'available' },
          { id: 's-3', seat_code: 'A3', status: 'reserved' },
          { id: 's-4', seat_code: 'A4', status: 'locked' },
          { id: 's-5', seat_code: 'A5', status: 'blocked' },
          { id: 's-6', seat_code: 'A6', status: 'guide' },
        ],
        error: null,
      },
      // MKT-007.4: solo ag-1 tiene canales de pago activos.
      {
        data: [{ agency_id: 'ag-1' }],
        error: null,
      },
      // MKT-008: contactos publicables; la fila de ag-99 nunca debe verse
      // porque no pertenece a ninguna oferta de ESTE viaje.
      {
        data: [
          {
            id: 'c-1',
            agency_id: 'ag-1',
            label: 'Ventas',
            phone: '+584121234567',
            channel: 'whatsapp',
          },
          {
            id: 'c-2',
            agency_id: 'ag-1',
            label: 'Emergencias',
            phone: '+18095551234',
            channel: 'call',
          },
          {
            id: 'c-99',
            agency_id: 'ag-99',
            label: 'Otra agencia',
            phone: '+447911123456',
            channel: 'call',
          },
        ],
        error: null,
      },
    );

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.trip.id).toBe(TRIP_ID);
    expect(body.trip.route).toEqual({
      origin: 'Barquisimeto',
      destination: 'Ruta de prueba',
    });
    expect(body.trip.vehicle_type).toBe('bus');
    expect(body.trip.capacity).toBe(31);
    expect(body.trip.seat_price).toBe(2020);
    expect(body.trip.installment_allowed).toBe(true);
    expect(body.trip.installment_amount_cents).toBe(1000);
    expect(body.trip.lock_ttl_seconds).toBe(900);
    expect(body.trip.offers).toHaveLength(2);
    expect(body.trip.offers[0]).toEqual({
      agency_id: 'ag-1',
      name: 'Agencia Central',
      logo_url: 'https://cdn.example.com/logo.png',
      primary_color: '#000024',
      secondary_color: '#0080FF',
      accent_color: '#00D4FF',
      phone: '04121234567',
      payment_methods_available: true,
      contacts: [
        {
          id: 'c-1',
          label: 'Ventas',
          phone: '+584121234567',
          channel: 'whatsapp',
        },
        {
          id: 'c-2',
          label: 'Emergencias',
          phone: '+18095551234',
          channel: 'call',
        },
      ],
    });
    // MKT-008: aislamiento por agencia — ag-2 no hereda contactos ajenos.
    expect(body.trip.offers[1]).toEqual({
      agency_id: 'ag-2',
      name: 'Rutas del Sol',
      logo_url: null,
      primary_color: null,
      secondary_color: null,
      accent_color: null,
      phone: null,
      payment_methods_available: false,
      contacts: [],
    });
    expect(body.trip.seats).toHaveLength(6);
    expect(body.trip.seats[0]).toEqual({
      id: 's-1',
      seat_code: 'A1',
      status: 'available',
    });
    expect(body.trip.availability).toEqual({
      total: 6,
      available: 2,
      reserved: 1,
      locked: 1,
      blocked: 1,
      guide: 1,
    });
    // MKT-007.4: la consulta de canales filtra por method soportado.
    const methodsChain = supabaseMock.from.mock.results[3]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(methodsChain.eq).toHaveBeenCalledWith('method', 'pago_movil');
    // MKT-008: la consulta de contactos exige los tres filtros públicos,
    // el orden de la agencia y el aislamiento por agency_id del viaje.
    const contactsChain = supabaseMock.from.mock.results[4]?.value as {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      is: ReturnType<typeof vi.fn>;
      in: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
    };
    expect(contactsChain.select).toHaveBeenCalledWith(
      'id, agency_id, label, phone, channel',
    );
    expect(contactsChain.in).toHaveBeenCalledWith('agency_id', ['ag-1', 'ag-2']);
    expect(contactsChain.eq).toHaveBeenCalledWith('is_public', true);
    expect(contactsChain.eq).toHaveBeenCalledWith('is_active', true);
    expect(contactsChain.is).toHaveBeenCalledWith('deleted_at', null);
    expect(contactsChain.order).toHaveBeenCalledWith('sort_order', {
      ascending: true,
    });
    expect(contactsChain.order).toHaveBeenCalledWith('created_at', {
      ascending: true,
    });
  });

  it('ordena las ofertas por agency_id para que el orden sea determinista', async () => {
    givenQueries(
      {
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: 1000,
          installment_allowed: false,
          installment_amount_cents: null,
          routes: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
        },
        error: null,
      },
      {
        data: [
          {
            agency_id: 'ag-2',
            agencies: {
              id: 'ag-2',
              name: 'Rutas del Sol',
              status: 'active',
              phone: null,
              agency_settings: null,
            },
          },
          {
            agency_id: 'ag-1',
            agencies: {
              id: 'ag-1',
              name: 'Agencia Central',
              status: 'active',
              phone: null,
              agency_settings: null,
            },
          },
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    );

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    // Todas las ofertas llegan completas: el orden jamás descarta filas.
    expect(body.trip.offers.map((offer: any) => offer.agency_id)).toEqual([
      'ag-2',
      'ag-1',
    ]);
    // Sin ORDER BY el orden lo fija el planificador de la BD y cambia con
    // cada DELETE+INSERT de update_trip (084); agency_id es único por viaje.
    const offersChain = supabaseMock.from.mock.results[1]?.value as {
      order: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
    };
    expect(offersChain.eq).toHaveBeenCalledWith('trip_id', TRIP_ID);
    expect(offersChain.eq).toHaveBeenCalledWith('agencies.status', 'active');
    expect(offersChain.order).toHaveBeenCalledWith('agency_id', {
      ascending: true,
    });
  });

  it('sin contactos publicables devuelve coleccion vacia y conserva el telefono legado', async () => {
    givenQueries(
      {
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: 2020,
          installment_allowed: false,
          installment_amount_cents: null,
          routes: { origin: 'A', destination: 'B' },
        },
        error: null,
      },
      {
        data: [
          {
            agency_id: 'ag-1',
            agencies: {
              id: 'ag-1',
              name: 'Agencia Central',
              status: 'active',
              phone: '04121234567',
              agency_settings: null,
            },
          },
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    );

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.trip.offers).toHaveLength(1);
    expect(body.trip.offers[0].contacts).toEqual([]);
    expect(body.trip.offers[0].phone).toBe('04121234567');
  });

  it('responde 500 TRIP_OFFERS_QUERY_ERROR cuando la consulta de contactos falla', async () => {
    givenQueries(
      {
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: null,
          installment_allowed: false,
          installment_amount_cents: null,
          routes: { origin: 'A', destination: 'B' },
        },
        error: null,
      },
      {
        data: [
          {
            agency_id: 'ag-1',
            agencies: {
              id: 'ag-1',
              name: 'Agencia Central',
              status: 'active',
              phone: null,
              agency_settings: null,
            },
          },
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      // Un fallo real de base de datos NO se convierte en "sin contactos".
      { data: null, error: { message: 'contacts table missing' } },
    );

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(res.status).toBe(500);
    expect(body.error?.code).toBe('TRIP_OFFERS_QUERY_ERROR');
    expect(body.error?.message).toBe('contacts table missing');
  });

  it('solo incluye agencias activas entre las ofertas', async () => {
    const offersChain = queryChain({ data: [], error: null });
    supabaseMock.from.mockReturnValueOnce(
      queryChain({
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: null,
          installment_allowed: false,
          installment_amount_cents: null,
          routes: { origin: 'A', destination: 'B' },
        },
        error: null,
      }),
    );
    supabaseMock.from.mockReturnValueOnce(offersChain);
    supabaseMock.from.mockReturnValueOnce(queryChain({ data: [], error: null }));

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.trip.seat_price).toBeNull();
    expect(body.trip.offers).toEqual([]);
    expect(offersChain.eq).toHaveBeenCalledWith('trip_id', TRIP_ID);
    expect(offersChain.eq).toHaveBeenCalledWith('agencies.status', 'active');
    expect(offersChain.select).toHaveBeenCalledWith(
      expect.stringContaining('agencies!inner'),
    );
  });

  it('responde 404 TRIP_NOT_FOUND cuando el id no es un UUID', async () => {
    const port = await startServer();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/public/trips/barquisimeto-caracas-2026-10-04`,
    );
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('TRIP_NOT_FOUND');
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });

  it('responde 404 TRIP_NOT_FOUND cuando el viaje no existe o no esta activo', async () => {
    givenQueries({ data: null, error: null });

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('TRIP_NOT_FOUND');
    expect(supabaseMock.from).toHaveBeenCalledTimes(1);
  });

  it('responde 500 TRIP_QUERY_ERROR cuando la consulta del viaje falla', async () => {
    givenQueries({ data: null, error: { message: 'boom' } });

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(500);
    expect(body.error?.code).toBe('TRIP_QUERY_ERROR');
    expect(body.error?.message).toBe('boom');
  });

  it('responde 500 TRIP_SEATS_QUERY_ERROR cuando falla la consulta de asientos', async () => {
    givenQueries(
      {
        data: {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: null,
          installment_allowed: false,
          installment_amount_cents: null,
          routes: { origin: 'A', destination: 'B' },
        },
        error: null,
      },
      { data: [], error: null },
      { data: null, error: { message: 'seats down' } },
    );

    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips/${TRIP_ID}`);
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(500);
    expect(body.error?.code).toBe('TRIP_SEATS_QUERY_ERROR');
  });

 afterEach(() => {
    supabaseMock.from.mockReset();
  });
});

describe('GET /api/public/trips (catálogo)', () => {
  let server: Server | null = null;

  afterEach(async () => {
    supabaseMock.from.mockReset();
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('lista los viajes activos con lock_ttl_seconds del servidor', async () => {
    const listChain = queryChain({
      data: [
        {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 31,
          vehicle_type: 'bus',
          status: 'active',
          seat_price: 2020,
          routes: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
        },
      ],
      error: null,
    });
    supabaseMock.from.mockReturnValueOnce(listChain);

    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0].id).toBe(TRIP_ID);
    expect(body.trips[0].seat_price).toBe(2020);
    expect(body.trips[0].lock_ttl_seconds).toBe(900);
    // Fila sin agencias: el campo existe siempre (arreglo posiblemente vacío).
    expect(body.trips[0].agencies).toEqual([]);
    // Nunca lista viajes cuya salida ya pasó.
    expect(listChain.eq).toHaveBeenCalledWith('status', 'active');
    expect(listChain.select).toHaveBeenCalledWith(
      expect.stringContaining('seat_price'),
    );
    expect(listChain.gte).toHaveBeenCalledWith(
      'departure_time',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(listChain.order).toHaveBeenCalledWith('departure_time', {
      ascending: true,
    });
  });

  it('devuelve seat_price null cuando el viaje no tiene precio', async () => {
    supabaseMock.from.mockReturnValueOnce(
      queryChain({
        data: [
          {
            id: TRIP_ID,
            departure_time: '2026-10-04T11:00:00+00:00',
            capacity: 10,
            vehicle_type: 'kia',
            status: 'active',
            seat_price: null,
            routes: { origin: 'A', destination: 'B' },
          },
        ],
        error: null,
      }),
    );

    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.trips[0].seat_price).toBeNull();
  });

  it('incluye las agencias activas del viaje en orden estable y sin N+1', async () => {
    const listChain = queryChain({
      data: [
        {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 31,
          vehicle_type: 'bus',
          status: 'active',
          seat_price: 2020,
          routes: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
          trip_agencies: [
            {
              agency_id: 'ag-z',
              agencies: { id: 'ag-z', name: 'Zeta Viajes', status: 'active' },
            },
            {
              agency_id: 'ag-a',
              agencies: { id: 'ag-a', name: 'Alfa Tours', status: 'active' },
            },
            {
              agency_id: 'ag-i',
              agencies: { id: 'ag-i', name: 'Inactiva', status: 'inactive' },
            },
          ],
        },
      ],
      error: null,
    });
    supabaseMock.from.mockReturnValueOnce(listChain);

    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(listChain.select).toHaveBeenCalledWith(
      expect.stringContaining('trip_agencies'),
    );
    // Solo agencias activas y en orden alfabético estable: el primer nombre
    // que pinta la tarjeta no depende del orden físico de las filas.
    expect(body.trips[0].agencies).toEqual([
      { id: 'ag-a', name: 'Alfa Tours' },
      { id: 'ag-z', name: 'Zeta Viajes' },
    ]);
    // Un único query con embed: jamás una consulta por viaje (N+1).
    expect(supabaseMock.from).toHaveBeenCalledTimes(1);
  });

  it('devuelve available_seats con la disponibilidad REAL (solo status=available)', async () => {
    const listChain = queryChain({
      data: [
        {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 31,
          vehicle_type: 'bus',
          status: 'active',
          seat_price: 2020,
          routes: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
          seats: [
            { status: 'available' },
            { status: 'available' },
            { status: 'reserved' },
            { status: 'reserved' },
            { status: 'locked' },
            { status: 'blocked' },
            { status: 'guide' },
          ],
        },
      ],
      error: null,
    });
    supabaseMock.from.mockReturnValueOnce(listChain);

    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    // Solo los asientos 'available' cuentan como libres.
    expect(body.trips[0].available_seats).toBe(2);
    expect(body.trips[0].capacity).toBe(31);
    // El embed viaja en el MISMO query del catálogo: sin N+1.
    expect(listChain.select).toHaveBeenCalledWith(
      expect.stringContaining('seats(status)'),
    );
    expect(supabaseMock.from).toHaveBeenCalledTimes(1);
  });

  it('lista un viaje cuyas agencias están inactivas con agencies vacio', async () => {
    const listChain = queryChain({
      data: [
        {
          id: TRIP_ID,
          departure_time: '2026-10-04T11:00:00+00:00',
          capacity: 10,
          vehicle_type: 'kia',
          status: 'active',
          seat_price: null,
          routes: { origin: 'A', destination: 'B' },
          trip_agencies: [
            {
              agency_id: 'ag-i',
              agencies: { id: 'ag-i', name: 'Inactiva', status: 'inactive' },
            },
          ],
        },
      ],
      error: null,
    });
    supabaseMock.from.mockReturnValueOnce(listChain);

    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/public/trips`);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    // El viaje sigue listado (sin !inner no se cae del catálogo), pero sin
    // ninguna agencia publicable.
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0].agencies).toEqual([]);
    expect(supabaseMock.from).toHaveBeenCalledTimes(1);
  });
});
