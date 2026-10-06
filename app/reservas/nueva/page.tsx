'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  LoaderCircle,
  RefreshCw,
  Ticket,
  Wallet,
} from 'lucide-react';
import {
  publicApi,
  seatApi,
  type PublicTripDetail,
  type PublicTripSeat,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatDateTimeShort, formatTime12h } from '@/lib/timezone';
import { formatSeatPrice } from '@/lib/price';
import { BusLayout } from '@/components/bus/BusLayout';
import { LockCountdown } from '@/components/booking/LockCountdown';
import { PassengerCard } from '@/components/booking/PassengerCard';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import {
  clearLockState,
  readLockState,
  writeLockState,
  type LockState,
  type PassengerDraft,
} from '@/lib/booking/lock-state';
import {
  emptyPassenger,
  passengerFullName,
  validatePassengers,
  type PassengerError,
} from '@/lib/booking/passengers';
import { applySeatRow, removeSeatRow } from '@/lib/booking/seat-map';
import { useSeatLocking } from '@/lib/booking/useSeatLocking';
import type { RealtimeSeatRow, SeatEventType } from '@/lib/realtime/subscriptions';

type Phase = 'loading' | 'missing' | 'expired' | 'error' | 'ready';

const STEP_LABELS = ['Asientos', 'Pasajeros', 'Resumen', 'Pago'];

function reconcilePassengers(
  lock: LockState,
  stored: PassengerDraft[],
): PassengerDraft[] {
  const bySeat = new Map(
    stored.map((passenger) => [passenger.seat_id, passenger]),
  );
  return lock.seats.map(
    (seat) => bySeat.get(seat.id) ?? emptyPassenger(seat.id),
  );
}

function withSeatStatus(
  current: PublicTripDetail,
  seatCode: string,
  status: PublicTripSeat['status'],
): PublicTripDetail {
  const seat = current.seats.find((item) => item.seat_code === seatCode);
  if (!seat) return current;
  return applySeatRow(current, { ...seat, status });
}

export default function NewReservationPage() {
  const router = useRouter();
  const auth = useOptionalAuthUser();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);
  const [passengers, setPassengers] = useState<PassengerDraft[]>([]);
  const [step, setStep] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<PassengerError[]>([]);
  const [busy, setBusy] = useState(false);
  const [verifyAttempt, setVerifyAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      const stored = readLockState();
      if (!stored) {
        setPhase('missing');
        return;
      }

      setPhase('loading');
      setError(null);

      const [tripResult, locksResult] = await Promise.allSettled([
        publicApi.tripDetail(stored.trip_id),
        seatApi.mySeatLocks(stored.trip_id),
      ]);
      if (cancelled) return;

      if (tripResult.status === 'rejected') {
        setPhase('error');
        setError(
          getApiErrorMessage(
            tripResult.reason,
            'No pudimos cargar tu selección. Intenta de nuevo.',
          ),
        );
        return;
      }
      if (locksResult.status === 'rejected') {
        setPhase('error');
        setError(
          getApiErrorMessage(
            locksResult.reason,
            'No pudimos verificar tus asientos. Intenta de nuevo.',
          ),
        );
        return;
      }

      const tripData = tripResult.value.trip;
      const locks = locksResult.value;
      const heldIds = new Set(locks.seats.map((seat) => seat.id));
      const missingSeats = stored.seats.filter((seat) => !heldIds.has(seat.id));

      if (
        !locks.lock_expires_at ||
        locks.seats.length === 0 ||
        missingSeats.length > 0
      ) {
        setLock(stored);
        setPhase('expired');
        return;
      }

      const verifiedLock: LockState = {
        ...stored,
        lock_expires_at: locks.lock_expires_at,
      };
      setTrip(tripData);
      setLock(verifiedLock);
      setPassengers(reconcilePassengers(verifiedLock, stored.passengers));
      setStep(0);
      setFieldErrors([]);
      setPhase('ready');
    };

    void verify();
    return () => {
      cancelled = true;
    };
  }, [verifyAttempt]);

  useEffect(() => {
    if (phase !== 'ready' || !lock || lock.seats.length === 0) return;
    writeLockState({ ...lock, passengers });
  }, [phase, lock, passengers]);

  const handleExpired = useCallback(() => {
    setPhase((current) => (current === 'ready' ? 'expired' : current));
  }, []);

  // ─── Realtime (estilo nomadas-tour) ─────────────────────────────────

  const handleSeatEvent = useCallback(
    (seat: RealtimeSeatRow, eventType: SeatEventType) => {
      setTrip((prev) => {
        if (!prev) return prev;
        return eventType === 'DELETE'
          ? removeSeatRow(prev, seat.id)
          : applySeatRow(prev, seat);
      });
    },
    [],
  );

  const handleSeatLost = useCallback((seat: RealtimeSeatRow) => {
    toast.error(`El asiento ${seat.seat_code} ya no está disponible`);
    setLock((prev) =>
      prev
        ? {
            ...prev,
            seats: prev.seats.filter((item) => item.id !== seat.id),
          }
        : prev,
    );
    setPassengers((prev) =>
      prev.filter((passenger) => passenger.seat_id !== seat.id),
    );
  }, []);

  const refreshTrip = useCallback(async () => {
    if (!trip) return;
    const fresh = await publicApi.tripDetail(trip.id).catch(() => null);
    if (fresh) setTrip(fresh.trip);
  }, [trip]);

  const tripEndedHandledRef = useRef(false);

  const handleTripCancelled = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error('Este viaje fue cancelado. Tu reserva no puede continuar.');
    clearLockState();
    router.push('/viajes');
  }, [router]);

  const handleTripCompleted = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error('Este viaje ya fue completado. Tu reserva no puede continuar.');
    clearLockState();
    router.push('/viajes');
  }, [router]);

  useSeatLocking({
    tripId: phase === 'ready' && trip ? trip.id : null,
    mySeatIds: lock?.seats.map((seat) => seat.id) ?? [],
    userId: auth?.user?.id ?? null,
    onSeatEvent: handleSeatEvent,
    onSeatLost: handleSeatLost,
    onTripCancelled: handleTripCancelled,
    onTripCompleted: handleTripCompleted,
    onRefresh: refreshTrip,
  });

  // Si la realtime vació la selección, la reserva queda expirada.
  useEffect(() => {
    if (phase === 'ready' && lock && lock.seats.length === 0) {
      setPhase('expired');
    }
  }, [phase, lock]);

  const handleToggleSeat = useCallback(
    async (seatCode: string) => {
      if (!trip || !lock || busy) return;
      const seat = trip.seats.find((item) => item.seat_code === seatCode);
      if (!seat) return;

      const mine = lock.seats.some((item) => item.id === seat.id);
      if (mine && lock.seats.length <= 1) {
        toast.error('Debe quedar al menos un asiento en tu selección');
        return;
      }

      setBusy(true);
      try {
        if (mine) {
          await seatApi.unlockSeats(trip.id, [seat.id]);
          setLock((prev) =>
            prev
              ? {
                  ...prev,
                  seats: prev.seats.filter((item) => item.id !== seat.id),
                }
              : prev,
          );
          setPassengers((prev) =>
            prev.filter((passenger) => passenger.seat_id !== seat.id),
          );
          setTrip((prev) =>
            prev ? withSeatStatus(prev, seatCode, 'available') : prev,
          );
          toast.success(`Asiento ${seatCode} liberado`);
        } else {
          if (seat.status !== 'available') return;
          const result = await seatApi.lockSeats(trip.id, [seat.id]);
          setLock((prev) =>
            prev
              ? {
                  ...prev,
                  lock_expires_at: result.lock_expires_at,
                  seats: [
                    ...prev.seats,
                    ...result.seats.filter(
                      (item) => !prev.seats.some((held) => held.id === item.id),
                    ),
                  ],
                }
              : prev,
          );
          setPassengers((prev) =>
            prev.some((passenger) => passenger.seat_id === seat.id)
              ? prev
              : [...prev, emptyPassenger(seat.id)],
          );
          setTrip((prev) =>
            prev ? withSeatStatus(prev, seatCode, 'locked') : prev,
          );
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          toast.error('Inicia sesión para continuar con tu reserva');
          router.push('/login?redirect=%2Freservas%2Fnueva');
        } else if (e instanceof ApiError && e.status === 409) {
          toast.error(
            getApiErrorMessage(e, 'Ese asiento ya no está disponible.'),
          );
          const refreshed = await publicApi.tripDetail(trip.id).catch(() => null);
          if (refreshed) {
            setTrip(refreshed.trip);
            setLock((prev) => {
              if (!prev) return prev;
              const stillHeld = prev.seats.filter((item) =>
                refreshed.trip.seats.some(
                  (seatItem) =>
                    seatItem.id === item.id && seatItem.status === 'locked',
                ),
              );
              return { ...prev, seats: stillHeld };
            });
            setPassengers((prev) =>
              prev.filter((passenger) =>
                refreshed.trip.seats.some(
                  (seatItem) =>
                    seatItem.id === passenger.seat_id &&
                    seatItem.status === 'locked',
                ),
              ),
            );
          }
        } else {
          toast.error(
            getApiErrorMessage(
              e,
              'No pudimos actualizar tus asientos. Intenta de nuevo.',
            ),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, lock, router, trip],
  );

  const changeSeats = useCallback(async () => {
    if (!lock) return;
    setBusy(true);
    try {
      await seatApi.unlockSeats(lock.trip_id);
      clearLockState();
      toast.success('Selección liberada. Elige tus asientos de nuevo.');
      router.push(`/viajes/${lock.trip_id}`);
    } catch (e) {
      toast.error(
        getApiErrorMessage(
          e,
          'No pudimos liberar tus asientos. Intenta de nuevo.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [lock, router]);

  const confirmPassengers = useCallback(() => {
    const errors = validatePassengers(passengers);
    setFieldErrors(errors);
    if (errors.length > 0) {
      toast.error('Revisa los datos de los pasajeros');
      return;
    }
    setStep(2);
  }, [passengers]);

  const seatCodes = useMemo(
    () => lock?.seats.map((seat) => seat.seat_code) ?? [],
    [lock],
  );

  const totalCents =
    trip && trip.seat_price !== null && lock
      ? trip.seat_price * lock.seats.length
      : null;

  const agencyName = useMemo(() => {
    if (!lock || !trip) return null;
    return (
      trip.offers.find((offer) => offer.agency_id === lock.agency_id)?.name ??
      null
    );
  }, [lock, trip]);

  if (phase === 'loading') {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="animate-pulse" aria-hidden="true">
          <div className="h-4 w-56 rounded-full bg-black/[0.06]" />
          <div className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="h-5 w-48 rounded-full bg-black/[0.06]" />
            <div className="mt-4 h-8 w-2/3 rounded bg-black/[0.06]" />
            <div className="mt-6 h-10 w-full rounded-full bg-black/[0.06]" />
          </div>
          <div className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="h-64 w-full rounded-2xl bg-black/[0.06]" />
          </div>
        </div>
        <span className="sr-only">Verificando tus asientos…</span>
      </main>
    );
  }

  if (phase === 'missing') {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9]">
            <Ticket size={24} strokeWidth={1.75} className="text-brand-navy" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold text-brand-navy">
            No tienes una selección activa
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Elige un viaje y tus asientos para comenzar. Los bloqueamos por 15
            minutos mientras completas tus datos.
          </p>
          <Link
            href="/viajes"
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Ver viajes disponibles
          </Link>
        </div>
      </main>
    );
  }

  if (phase === 'expired') {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2]">
            <AlertTriangle size={24} strokeWidth={1.75} className="text-[#ef4444]" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold text-brand-navy">
            Tu selección expiró
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Los asientos volvieron a estar disponibles. Elige de nuevo para
            continuar con tu reserva.
          </p>
          <button
            type="button"
            onClick={() => {
              clearLockState();
              router.push(lock ? `/viajes/${lock.trip_id}` : '/viajes');
            }}
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Elegir asientos de nuevo
          </button>
        </div>
      </main>
    );
  }

  if (phase === 'error' || !trip || !lock) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2]">
            <AlertTriangle size={24} strokeWidth={1.75} className="text-[#ef4444]" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold text-brand-navy">
            No pudimos cargar tu selección
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
          <button
            type="button"
            onClick={() => setVerifyAttempt((attempt) => attempt + 1)}
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  const seatCodeFor = (seatId: string) =>
    lock.seats.find((seat) => seat.id === seatId)?.seat_code ?? '—';

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
      <header className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase text-brand-muted">
              Tu reserva
            </p>
            <h1 className="mt-2 text-[28px] font-extrabold leading-tight text-brand-navy">
              {trip.route.origin} → {trip.route.destination}
            </h1>
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-brand-muted">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" />
                {formatDateTimeShort(trip.departure_time)}
              </span>
              <span>{formatTime12h(trip.departure_time)}</span>
              {agencyName ? <span>{agencyName}</span> : null}
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 sm:items-end">
            <LockCountdown
              expiresAt={lock.lock_expires_at}
              onExpired={handleExpired}
            />
            <button
              type="button"
              onClick={() => void changeSeats()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <LoaderCircle
                  size={16}
                  strokeWidth={1.75}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              Cambiar asientos
            </button>
          </div>
        </div>

        <ol
          aria-label="Pasos de la reserva"
          className="mt-6 flex flex-wrap gap-2"
        >
          {STEP_LABELS.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? 'step' : undefined}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                index === step
                  ? 'bg-brand-navy text-white'
                  : index < step
                    ? 'bg-[#ecfdf5] text-[#059669]'
                    : 'bg-[#f1f5f9] text-brand-muted'
              }`}
            >
              {index < step ? (
                <Check size={14} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <span aria-hidden="true">{index + 1}</span>
              )}
              {label}
            </li>
          ))}
        </ol>
      </header>

      {step === 0 ? (
        <section
          aria-label="Asientos"
          className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
              Elige tus asientos
            </h2>
            <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
              {lock.seats.length} seleccionado
              {lock.seats.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="mt-6">
            <BusLayout
              vehicleType={trip.vehicle_type}
              seats={trip.seats}
              selectedSeats={seatCodes}
              onToggleSeat={(seatCode) => {
                if (!busy) void handleToggleSeat(seatCode);
              }}
            />
          </div>

          <p className="mt-4 text-center text-xs text-brand-muted">
            Tus asientos quedan bloqueados mientras completas el formulario.
          </p>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={busy || lock.seats.length === 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
            >
              Continuar con los pasajeros
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </section>
      ) : step === 1 ? (
        <section aria-label="Pasajeros" className="mt-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
              Datos de los pasajeros
            </h2>
            <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
              {passengers.length} pasajero{passengers.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="mt-5 space-y-4">
            {passengers.map((passenger, index) => (
              <PassengerCard
                key={passenger.seat_id}
                seatCode={seatCodeFor(passenger.seat_id)}
                index={index}
                passenger={passenger}
                errors={fieldErrors}
                disabled={busy}
                onChange={(updated) =>
                  setPassengers((prev) =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? updated : item,
                    ),
                  )
                }
              />
            ))}
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => setStep(0)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              Volver a los asientos
            </button>
            <button
              type="button"
              onClick={confirmPassengers}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continuar con el resumen
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </section>
      ) : step === 2 ? (
        <section
          aria-label="Resumen"
          className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-8"
        >
          <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
            Resumen de tu reserva
          </h2>

          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-medium uppercase text-brand-muted">
                Viaje
              </dt>
              <dd className="mt-1 text-sm font-semibold text-brand-navy">
                {trip.route.origin} → {trip.route.destination}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase text-brand-muted">
                Salida
              </dt>
              <dd className="mt-1 text-sm font-semibold text-brand-navy">
                {formatDateTimeShort(trip.departure_time)} ·{' '}
                {formatTime12h(trip.departure_time)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase text-brand-muted">
                {agencyName ? 'Agencia' : 'Oferta'}
              </dt>
              <dd className="mt-1 text-sm font-semibold text-brand-navy">
                {agencyName ?? 'Oferta del viaje'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase text-brand-muted">
                Asientos
              </dt>
              <dd className="mt-1 text-sm font-semibold text-brand-navy">
                {seatCodes.join(', ')}
              </dd>
            </div>
          </dl>

          <h3 className="mt-6 border-l-4 border-brand-cyan pl-3 text-[17px] font-semibold text-brand-navy">
            Pasajeros
          </h3>
          <ul className="mt-3 space-y-2">
            {passengers.map((passenger) => (
              <li
                key={passenger.seat_id}
                className="flex flex-col gap-1 rounded-[10px] bg-[#f8fafc] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-semibold text-brand-navy">
                  {passengerFullName(passenger)}
                </span>
                <span className="text-brand-muted">
                  {passenger.document} · Asiento{' '}
                  {seatCodeFor(passenger.seat_id)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex items-center justify-between rounded-[10px] bg-[#f1f5f9] px-4 py-4">
            <span className="text-sm font-semibold text-brand-navy">
              Total {lock.seats.length} asiento
              {lock.seats.length === 1 ? '' : 's'}
            </span>
            <span className="text-[24px] font-extrabold leading-none text-brand-navy">
              {totalCents !== null
                ? formatSeatPrice(totalCents)
                : 'Precio no disponible'}
            </span>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              Editar pasajeros
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continuar al pago
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </section>
      ) : (
        <section
          aria-label="Pago"
          className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-12 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:px-8"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9]">
            <Wallet size={24} strokeWidth={1.75} className="text-brand-navy" aria-hidden="true" />
          </div>
          <h2 className="mt-4 inline-block border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
            Pago
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-brand-muted">
            El pago estará disponible en la próxima etapa de esta reserva. Tus
            asientos siguen bloqueados mientras tanto.
          </p>
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              Volver al resumen
            </button>
          </div>
        </section>
      )}
    </main>
  );
}


