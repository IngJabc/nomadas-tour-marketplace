import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToTripSeats, subscribeToTrips } from '../subscriptions';

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
