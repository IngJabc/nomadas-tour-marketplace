import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  subscribeToTripSeats,
  subscribeToTrips,
  type RealtimeSeatRow,
  type SeatEventType,
  type SeatUpdatePayload,
} from '@/lib/realtime/subscriptions';
import { useSeatLocking, type UseSeatLockingOptions } from '../useSeatLocking';

const { seatHandlers, tripHandlers, cleanupMock } = vi.hoisted(() => ({
  seatHandlers: [] as Array<(payload: SeatUpdatePayload) => void>,
  tripHandlers: [] as Array<(payload: unknown) => void>,
  cleanupMock: vi.fn(),
}));

vi.mock('@/lib/realtime/subscriptions', () => ({
  subscribeToTripSeats: vi.fn(
    (_tripIds: string[], callback: (payload: SeatUpdatePayload) => void) => {
      seatHandlers.push(callback);
      return cleanupMock;
    },
  ),
  subscribeToTrips: vi.fn(
    (_tripIds: string[], callback: (payload: unknown) => void) => {
      tripHandlers.push(callback);
      return cleanupMock;
    },
  ),
}));

interface Handlers {
  onSeatEvent: Mock<(seat: RealtimeSeatRow, eventType: SeatEventType) => void>;
  onSeatLost: Mock<(seat: RealtimeSeatRow) => void>;
  onTripCancelled: Mock<() => void>;
  onTripCompleted: Mock<() => void>;
  onRefresh: Mock<() => void>;
}

function makeHandlers(): Handlers {
  return {
    onSeatEvent: vi.fn<
      (seat: RealtimeSeatRow, eventType: SeatEventType) => void
    >(),
    onSeatLost: vi.fn<(seat: RealtimeSeatRow) => void>(),
    onTripCancelled: vi.fn<() => void>(),
    onTripCompleted: vi.fn<() => void>(),
    onRefresh: vi.fn<() => void>(),
  };
}

function makeOptions(
  handlers: Handlers,
  overrides: Partial<UseSeatLockingOptions> = {},
): UseSeatLockingOptions {
  return {
    tripId: 'trip-1',
    mySeatIds: ['seat-1'],
    userId: 'user-me',
    ...handlers,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seatHandlers.length = 0;
  tripHandlers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSeatLocking', () => {
  it('no se suscribe cuando no hay viaje activo', () => {
    const handlers = makeHandlers();
    renderHook(() =>
      useSeatLocking(makeOptions(handlers, { tripId: null })),
    );

    expect(subscribeToTripSeats).not.toHaveBeenCalled();
    expect(subscribeToTrips).not.toHaveBeenCalled();
  });

  it('se suscribe a asientos y trips del viaje y limpia al desmontar', () => {
    const handlers = makeHandlers();
    const { unmount } = renderHook(() => useSeatLocking(makeOptions(handlers)));

    expect(subscribeToTripSeats).toHaveBeenCalledWith(
      ['trip-1'],
      expect.any(Function),
    );
    expect(subscribeToTrips).toHaveBeenCalledWith(
      ['trip-1'],
      expect.any(Function),
    );
    expect(seatHandlers).toHaveLength(1);
    expect(tripHandlers).toHaveLength(1);

    unmount();
    expect(cleanupMock).toHaveBeenCalledTimes(2);
  });

  it('usa los callbacks más recientes sin resuscribir', () => {
    const first = vi.fn();
    const { rerender } = renderHook(
      (onSeatEvent: (seat: unknown, type: string) => void) =>
        useSeatLocking({ tripId: 'trip-1', onSeatEvent }),
      { initialProps: first },
    );
    const second = vi.fn();

    rerender(second);
    expect(subscribeToTripSeats).toHaveBeenCalledTimes(1);

    const seat = {
      id: 'seat-9',
      trip_id: 'trip-1',
      seat_code: 'A9',
      status: 'available' as const,
    };
    seatHandlers[0]({ eventType: 'UPDATE', seat });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(seat, 'UPDATE');
  });

  it('reporta pérdida cuando un asiento propio queda disponible', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    const seat = {
      id: 'seat-1',
      trip_id: 'trip-1',
      seat_code: 'A1',
      status: 'available' as const,
    };
    seatHandlers[0]({ eventType: 'UPDATE', seat });

    expect(handlers.onSeatEvent).toHaveBeenCalledWith(seat, 'UPDATE');
    expect(handlers.onSeatLost).toHaveBeenCalledWith(seat);
  });

  it('distingue un lock ajeno de un lock propio por locked_by', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    const stolen = {
      id: 'seat-1',
      trip_id: 'trip-1',
      seat_code: 'A1',
      status: 'locked' as const,
      locked_by: 'user-other',
    };
    seatHandlers[0]({ eventType: 'UPDATE', seat: stolen });
    expect(handlers.onSeatLost).toHaveBeenCalledTimes(1);
    expect(handlers.onSeatLost).toHaveBeenCalledWith(stolen);

    const mine = {
      id: 'seat-1',
      trip_id: 'trip-1',
      seat_code: 'A1',
      status: 'locked' as const,
      locked_by: 'user-me',
    };
    seatHandlers[0]({ eventType: 'UPDATE', seat: mine });
    expect(handlers.onSeatLost).toHaveBeenCalledTimes(1);
  });

  it('no reporta pérdida para asientos que no son míos', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    seatHandlers[0]({
      eventType: 'UPDATE',
      seat: {
        id: 'seat-7',
        trip_id: 'trip-1',
        seat_code: 'A7',
        status: 'reserved',
      },
    });

    expect(handlers.onSeatEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onSeatLost).not.toHaveBeenCalled();
  });

  it('reporta la pérdida cuando un asiento propio se elimina', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    const seat = {
      id: 'seat-1',
      trip_id: 'trip-1',
      seat_code: 'A1',
      status: 'locked' as const,
      locked_by: 'user-me',
    };
    seatHandlers[0]({ eventType: 'DELETE', seat });

    expect(handlers.onSeatEvent).toHaveBeenCalledWith(seat, 'DELETE');
    expect(handlers.onSeatLost).toHaveBeenCalledWith(seat);
  });

  it('detecta viajes cancelados o completados del viaje activo', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    tripHandlers[0]({
      eventType: 'UPDATE',
      trip: { id: 'trip-1', status: 'cancelled' },
    });
    expect(handlers.onTripCancelled).toHaveBeenCalledTimes(1);
    expect(handlers.onTripCompleted).not.toHaveBeenCalled();

    tripHandlers[0]({
      eventType: 'UPDATE',
      trip: { id: 'trip-1', status: 'completed' },
    });
    expect(handlers.onTripCompleted).toHaveBeenCalledTimes(1);

    tripHandlers[0]({
      eventType: 'UPDATE',
      trip: { id: 'trip-1', status: 'active' },
    });
    tripHandlers[0]({
      eventType: 'UPDATE',
      trip: { id: 'otro-viaje', status: 'cancelled' },
    });
    expect(handlers.onTripCancelled).toHaveBeenCalledTimes(1);
    expect(handlers.onTripCompleted).toHaveBeenCalledTimes(1);
  });

  it('agrupa los refrescos en una sola llamada con debounce de 500ms', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));
    vi.useFakeTimers();

    seatHandlers[0]({
      eventType: 'UPDATE',
      seat: {
        id: 'seat-2',
        trip_id: 'trip-1',
        seat_code: 'A2',
        status: 'locked',
        locked_by: 'user-other',
      },
    });
    seatHandlers[0]({
      eventType: 'UPDATE',
      seat: {
        id: 'seat-3',
        trip_id: 'trip-1',
        seat_code: 'A3',
        status: 'reserved',
      },
    });

    expect(handlers.onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(handlers.onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);

    seatHandlers[0]({
      eventType: 'UPDATE',
      seat: {
        id: 'seat-4',
        trip_id: 'trip-1',
        seat_code: 'A4',
        status: 'available',
      },
    });
    vi.advanceTimersByTime(500);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(2);
  });

  it('omite eventos de asientos de otros viajes', () => {
    const handlers = makeHandlers();
    renderHook(() => useSeatLocking(makeOptions(handlers)));

    seatHandlers[0]({
      eventType: 'UPDATE',
      seat: {
        id: 'seat-x',
        trip_id: 'otro-viaje',
        seat_code: 'A1',
        status: 'available',
      },
    });

    expect(handlers.onSeatEvent).not.toHaveBeenCalled();
    expect(handlers.onSeatLost).not.toHaveBeenCalled();
  });
});
