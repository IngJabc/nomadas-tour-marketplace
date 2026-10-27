import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeToPurchaseHistory,
  subscribeToPurchaseTicket,
  subscribeToTripCatalog,
  subscribeToTripSeats,
  subscribeToTrips,
} from '../subscriptions';

const { handlers, removeChannel, createClientMock, channel } = vi.hoisted(() => {
  const handlers: Array<{
    config: Record<string, unknown>;
    callback: (payload: unknown) => void;
  }> = [];
  const removeChannel = vi.fn();
  const channel: Record<string, unknown> = {};
  channel.on = (
    _type: string,
    config: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ) => {
    handlers.push({ config, callback });
    return channel;
  };
  channel.subscribe = () => channel;
  const createClientMock = vi.fn(() => ({ channel: () => channel, removeChannel }));
  return { handlers, removeChannel, createClientMock, channel };
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: createClientMock,
}));

beforeEach(() => {
  handlers.length = 0;
  removeChannel.mockClear();
  createClientMock.mockClear();
});

describe('subscribeToTripSeats', () => {
  it('sin tripIds no crea cliente ni suscribe', () => {
    const cleanup = subscribeToTripSeats([], () => {});

    expect(createClientMock).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it('suscribe a la tabla seats con filtro por trip_id y el cleanup remueve el canal', () => {
    const cleanup = subscribeToTripSeats(['trip-a', 'trip-b'], () => {});

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].config).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'seats',
      filter: 'trip_id=in.(trip-a,trip-b)',
    });

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });

  it('entrega eventos UPDATE con la fila completa del asiento', () => {
    const onSeatUpdate = vi.fn();
    subscribeToTripSeats(['trip-a'], onSeatUpdate);

    const row = {
      id: 'seat-1',
      trip_id: 'trip-a',
      seat_code: 'A1',
      status: 'locked',
      locked_by: 'user-2',
    };
    handlers[0].callback({ eventType: 'UPDATE', new: row });

    expect(onSeatUpdate).toHaveBeenCalledWith({
      eventType: 'UPDATE',
      seat: row,
    });
  });

  it('entrega DELETE solo cuando la fila vieja trae el asiento', () => {
    const onSeatUpdate = vi.fn();
    subscribeToTripSeats(['trip-a'], onSeatUpdate);

    handlers[0].callback({
      eventType: 'DELETE',
      old: { id: 'seat-1', trip_id: 'trip-a', seat_code: 'A1' },
    });
    expect(onSeatUpdate).toHaveBeenCalledTimes(1);
    expect(onSeatUpdate).toHaveBeenCalledWith({
      eventType: 'DELETE',
      seat: { id: 'seat-1', trip_id: 'trip-a', seat_code: 'A1' },
    });

    handlers[0].callback({ eventType: 'DELETE', old: { id: 'seat-2' } });
    expect(onSeatUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignora eventos sin fila utilizable', () => {
    const onSeatUpdate = vi.fn();
    subscribeToTripSeats(['trip-a'], onSeatUpdate);

    handlers[0].callback({ eventType: 'UPDATE', new: null });
    handlers[0].callback({ eventType: 'UPDATE', new: {} });

    expect(onSeatUpdate).not.toHaveBeenCalled();
  });
});

describe('subscribeToTrips', () => {
  it('suscribe a la tabla trips con filtro por id y entrega cambios', () => {
    const onTripUpdate = vi.fn();
    const cleanup = subscribeToTrips(['trip-a'], onTripUpdate);

    expect(handlers[0].config).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'trips',
      filter: 'id=in.(trip-a)',
    });

    handlers[0].callback({
      eventType: 'UPDATE',
      new: { id: 'trip-a', status: 'cancelled' },
    });
    expect(onTripUpdate).toHaveBeenCalledWith({
      eventType: 'UPDATE',
      trip: { id: 'trip-a', status: 'cancelled' },
    });

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('sin tripIds no crea cliente', () => {
    subscribeToTrips([], () => {});

    expect(createClientMock).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });
});

describe('subscribeToPurchaseHistory (RT-04A)', () => {
  it('sin customerId no crea cliente ni suscribe', () => {
    const cleanup = subscribeToPurchaseHistory('', () => {});

    expect(createClientMock).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it('suscribe checkout_attempts, reservations y payments filtrados por el cliente', () => {
    const cleanup = subscribeToPurchaseHistory('user-1', () => {});

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(3);
    expect(handlers[0].config).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'checkout_attempts',
      filter: 'customer_id=eq.user-1',
    });
    expect(handlers[1].config).toMatchObject({
      table: 'reservations',
      filter: 'customer_id=eq.user-1',
    });
    expect(handlers[2].config).toMatchObject({
      table: 'payments',
      filter: 'customer_id=eq.user-1',
    });

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(3);
  });

  it('invoca onChange en cada evento sin consumir el payload', () => {
    const onChange = vi.fn();
    subscribeToPurchaseHistory('user-1', onChange);

    handlers[0].callback({ eventType: 'UPDATE', new: { id: 'att-1', status: 'verified' } });
    handlers[2].callback({ eventType: 'INSERT', new: { id: 'pay-1' } });

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeToPurchaseTicket (RT-04A)', () => {
  it('sin customerId o attemptId no crea cliente', () => {
    subscribeToPurchaseTicket('', 'att-1', () => {});
    subscribeToPurchaseTicket('user-1', '', () => {});

    expect(createClientMock).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });

  it('filtra el intento por id + cliente y agrega reservas y pagos propios', () => {
    const cleanup = subscribeToPurchaseTicket('user-1', 'att-9', () => {});

    expect(handlers).toHaveLength(3);
    expect(handlers[0].config).toMatchObject({
      table: 'checkout_attempts',
      filter: 'id=eq.att-9&customer_id=eq.user-1',
    });
    expect(handlers[1].config).toMatchObject({
      table: 'reservations',
      filter: 'customer_id=eq.user-1',
    });
    expect(handlers[2].config).toMatchObject({
      table: 'payments',
      filter: 'customer_id=eq.user-1',
    });

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(3);
  });

  it('dispara onChange ante eventos de compra y limpia los 3 canales', () => {
    const onChange = vi.fn();
    const cleanup = subscribeToPurchaseTicket('user-1', 'att-9', onChange);

    handlers[1].callback({ eventType: 'INSERT', new: { id: 'res-1' } });
    expect(onChange).toHaveBeenCalledTimes(1);

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(3);
  });
});

describe('subscribeToTripCatalog (RT-04A)', () => {
  it('siempre suscribe trips, y sin ids no crea trip_agencies ni agencies', () => {
    const cleanup = subscribeToTripCatalog([], [], () => {});

    expect(handlers).toHaveLength(1);
    expect(handlers[0].config).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'trips',
    });
    expect(handlers[0].config.filter).toBeUndefined();

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('acota trip_agencies y agencies a los ids cargados', () => {
    subscribeToTripCatalog(['trip-a', 'trip-b'], ['ag-1'], () => {});

    expect(handlers).toHaveLength(3);
    expect(handlers[1].config).toMatchObject({
      table: 'trip_agencies',
      filter: 'trip_id=in.(trip-a,trip-b)',
    });
    expect(handlers[2].config).toMatchObject({
      table: 'agencies',
      filter: 'id=in.(ag-1)',
    });
  });

  it('con ids de viaje pero sin agencias solo agrega trip_agencies', () => {
    const cleanup = subscribeToTripCatalog(['trip-a'], [], () => {});

    expect(handlers).toHaveLength(2);
    expect(handlers[1].config).toMatchObject({ table: 'trip_agencies' });

    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(2);
  });

  it('dispara onChange ante eventos del catálogo', () => {
    const onChange = vi.fn();
    subscribeToTripCatalog(['trip-a'], ['ag-1'], onChange);

    handlers[0].callback({ eventType: 'UPDATE', new: { id: 'trip-a', status: 'cancelled' } });
    handlers[2].callback({ eventType: 'UPDATE', new: { id: 'ag-1', status: 'inactive' } });

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
