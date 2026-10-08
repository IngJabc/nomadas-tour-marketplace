'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  LoaderCircle,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Ticket,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  publicApi,
  reservationApi,
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
import { claimPendingGuestLocks } from '@/lib/booking/guest-claim';
import { useSeatLocking } from '@/lib/booking/useSeatLocking';
import type { RealtimeSeatRow, SeatEventType } from '@/lib/realtime/subscriptions';

type Phase = 'loading' | 'missing' | 'expired' | 'unpriced' | 'error' | 'ready';

// Aviso compartido por el estado temprano y por la defensa del POST: el RPC
// sigue validando TRIP_PRICE_MISSING, pero el usuario no debe llegar hasta ahí.
const UNPRICED_MESSAGE =
  'Este viaje no tiene un precio configurado y no puede reservarse en este momento.';


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

/**
 * Verificación de los locks propios: el endpoint autenticado es la vía normal.
 * Un guest sin sesión (401) o una cuenta no-customer (403 CUSTOMER_REQUIRED)
 * conservan sus locks en la cookie HttpOnly, así que se verifican con
 * `guest-locks` — mismo estado, otro mecanismo de lectura ya existente
 * (Fase 4), sin relockear ni tocar el TTL.
 */
async function verifySeatLocks(tripId: string) {
  try {
    return await seatApi.mySeatLocks(tripId);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.code === 'CUSTOMER_REQUIRED')
    ) {
      try {
        return await seatApi.getGuestLocks(tripId);
      } catch {
        return null;
      }
    }
    throw error;
  }
}

function NewReservationContent() {
  const router = useRouter();
  const auth = useOptionalAuthUser();
  // Entrada directa del catálogo: `/reservas/nueva?trip=<id>` carga el viaje
  // y arranca el checkout con 0 asientos (el mapa está en la propia pantalla).
  const searchParams = useSearchParams();
  const tripParam = searchParams.get('trip');
  const authLoading = auth?.loading ?? false;
  // Destino de vuelta tras login/registro: conserva `?trip=` para no perder
  // la entrada directa desde el catálogo.
  const authRedirect = encodeURIComponent(
    tripParam ? `/reservas/nueva?trip=${tripParam}` : '/reservas/nueva',
  );
  const authRef = useRef(auth);
  authRef.current = auth;

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);
  const [passengers, setPassengers] = useState<PassengerDraft[]>([]);
  const [fieldErrors, setFieldErrors] = useState<PassengerError[]>([]);
  const [busy, setBusy] = useState(false);
  const [verifyAttempt, setVerifyAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Dedupe en vuelo: evita doble POST por Strict Mode, re-renders o dos
  // clics concurrentes. El backend además es idempotente (201 → 200).
  const creatingRef = useRef(false);

  useEffect(() => {
    // Sin la identidad resuelta no se puede decidir guest vs customer.
    if (authLoading) return;
    let cancelled = false;

    // Entrada fresca desde el catálogo: el viaje viene por `?trip=` y todavía
    // no hay asientos elegidos (la LockState solo se persiste con ≥1 asiento).
    const startFresh = async (tripId: string) => {
      setPhase('loading');
      setError(null);
      try {
        const response = await publicApi.tripDetail(tripId);
        if (cancelled) return;
        // Validación temprana: sin trips.seat_price no hay precio que cobrar,
        // así que el checkout se bloquea ANTES de elegir asientos.
        if (response.trip.seat_price === null) {
          setTrip(response.trip);
          setLock(null);
          setPassengers([]);
          setFieldErrors([]);
          setCreateError(null);
          setPhase('unpriced');
          return;
        }
        setTrip(response.trip);
        setLock({
          trip_id: response.trip.id,
          agency_id: response.trip.offers[0]?.agency_id ?? null,
          seats: [],
          lock_expires_at: '',
          passengers: [],
        });
        setPassengers([]);
        setFieldErrors([]);
        setCreateError(null);
        setPhase('ready');
      } catch (e) {
        if (cancelled) return;
        setPhase('error');
        setError(
          getApiErrorMessage(e, 'No pudimos cargar el viaje. Intenta de nuevo.'),
        );
      }
    };

    const verify = async () => {
      const stored = readLockState();

      if (!stored) {
        if (!tripParam) {
          setPhase('missing');
          return;
        }
        await startFresh(tripParam);
        return;
      }

      if (tripParam && stored.trip_id !== tripParam) {
        // El usuario eligió OTRO viaje desde el catálogo: la selección
        // anterior se libera (best effort; el TTL del backend también la
        // libera) y se arranca de cero con el viaje del enlace.
        const user = authRef.current?.user;
        const asGuest = !user || user.role !== 'customer';
        void (asGuest
          ? seatApi.unlockGuestSeats(stored.trip_id, undefined)
          : seatApi.unlockSeats(stored.trip_id)
        ).catch(() => undefined);
        clearLockState();
        await startFresh(tripParam);
        return;
      }

      setPhase('loading');
      setError(null);

      // Claim guest → customer ANTES de verificar con el endpoint autenticado.
      // Un guest que llega aquí después del login conserva sus locks con la
      // MISMA expiración; sin este paso `mySeatLocks` no los vería como propios.
      await claimPendingGuestLocks(stored.trip_id);
      if (cancelled) return;

      const [tripResult, locksResult] = await Promise.allSettled([
        publicApi.tripDetail(stored.trip_id),
        verifySeatLocks(stored.trip_id),
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

      // Validación temprana sobre la selección ya persistida: el viaje dejó
      // de tener precio (o nunca lo tuvo). Se bloquea el checkout sin tocar
      // la LockState del usuario; el backend sigue validando TRIP_PRICE_MISSING.
      if (tripData.seat_price === null) {
        setTrip(tripData);
        setLock(stored);
        setPhase('unpriced');
        return;
      }

      const locks = locksResult.value;
      const heldIds = new Set(
        (locks?.seats ?? []).map((seat) => seat.id),
      );
      const missingSeats = stored.seats.filter((seat) => !heldIds.has(seat.id));

      if (
        !locks ||
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
      setFieldErrors([]);
      setPhase('ready');
    };

    void verify();
    return () => {
      cancelled = true;
    };
  }, [verifyAttempt, tripParam, authLoading]);

  useEffect(() => {
    if (phase !== 'ready' || !lock || lock.seats.length === 0) return;
    writeLockState({ ...lock, passengers });
  }, [phase, lock, passengers]);

  const handleExpired = useCallback(() => {
    setPhase((current) => (current === 'ready' ? 'expired' : current));
  }, []);

  const handleCreateError = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        setCreateError('Tu sesión expiró. Inicia sesión de nuevo.');
        void authRef.current?.refresh();
        return;
      }
      if (
        err.code === 'SEAT_LOCK_EXPIRED' ||
        err.code === 'SEAT_NOT_OWNED' ||
        err.code === 'SEAT_NOT_FOUND'
      ) {
        // El backend no creó nada: revalidar contra el mecanismo existente.
        toast.error(err.message);
        setPhase('expired');
        return;
      }
      if (err.code === 'TRIP_PRICE_MISSING') {
        setCreateError(UNPRICED_MESSAGE);
        return;
      }
      if (err.status === 429) {
        setCreateError(
          'Demasiados intentos. Espera un momento y vuelve a intentarlo.',
        );
        return;
      }
      setCreateError(
        err.message || 'No pudimos crear tu reserva. Intenta de nuevo.',
      );
      return;
    }
    setCreateError(
      getApiErrorMessage(err, 'No pudimos crear tu reserva. Intenta de nuevo.'),
    );
  }, []);

  // ─── Creación de la reserva (MKT-004 Fase B) ─────────────────────────
  // Disparada por "Confirmar y pagar" en el checkout de una sola página.
  // Guards: reservation_id (refresh/back-forward), ref en vuelo (Strict Mode,
  // re-renders, doble clic) y validación de pasajeros ANTES del POST (§14).
  const handleCreate = useCallback(async () => {
    if (!lock || creatingRef.current || lock.reservation_id) return;
    const sessionUser = authRef.current?.user;
    if (!sessionUser) return; // gate: sin sesión no hay POST
    if (sessionUser.role !== 'customer') return; // backend: CUSTOMER_REQUIRED
    if (!lock.agency_id) return; // sin oferta de agencia no hay payload válido
    // Defensa en profundidad: el viaje sin precio nunca debe llegar al POST
    // (el estado 'unpriced' ni siquiera renderiza este botón).
    if (trip?.seat_price === null) {
      setCreateError(UNPRICED_MESSAGE);
      return;
    }
    if (passengers.length === 0 || passengers.length !== lock.seats.length) {
      return;
    }

    const errors = validatePassengers(passengers);
    setFieldErrors(errors);
    if (errors.length > 0) {
      toast.error('Revisa los datos de los pasajeros');
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);

    const snapshot = { ...lock, passengers };

    try {
      const result = await reservationApi.create({
        trip_id: lock.trip_id,
        agency_id: lock.agency_id,
        seat_ids: lock.seats.map((seat) => seat.id),
        passengers: passengers.map(
          ({ seat_id, first_name, last_name, document, phone }) => ({
            seat_id,
            first_name,
            last_name,
            document,
            phone,
          }),
        ),
      });
      // Persistir ANTES del setState: si el usuario refresca justo aquí,
      // LockState ya tiene la reserva y no se vuelve a POSTear (§14).
      writeLockState({ ...snapshot, reservation_id: result.reservation_id });
      setLock((prev) =>
        prev ? { ...prev, reservation_id: result.reservation_id } : prev,
      );
      setFieldErrors([]);
      toast.success('Reserva creada');
    } catch (err: unknown) {
      handleCreateError(err);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [handleCreateError, lock, passengers, trip]);

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
  // `lock_expires_at` distingue el estado inicial (0 asientos, sin lock real,
  // entrada fresca desde el catálogo) de una selección realmente perdida.
  useEffect(() => {
    if (
      phase === 'ready' &&
      lock &&
      lock.seats.length === 0 &&
      lock.lock_expires_at
    ) {
      setPhase('expired');
    }
  }, [phase, lock]);

  const handleToggleSeat = useCallback(
    async (seatCode: string) => {
      if (!trip || !lock || busy || lock.reservation_id) return;
      const seat = trip.seats.find((item) => item.seat_code === seatCode);
      if (!seat) return;

      const mine = lock.seats.some((item) => item.id === seat.id);
      if (mine && lock.seats.length <= 1) {
        toast.error('Debe quedar al menos un asiento en tu selección');
        return;
      }

      // El sistema de lock lo decide la sesión: guest → cookie HttpOnly
      // (`/lock-guest`), customer → endpoint autenticado (`/lock`).
      // Nunca los dos a la vez, y elegir asientos NUNCA manda al login:
      // el gate de sesión vive solo en el paso de pago.
      // Solo el rol `customer` usa endpoints autenticados: invitados y cuentas
      // no-customer (p. ej. superadmin) lockean con la cookie guest.
      const user = authRef.current?.user;
      const asGuest = !user || user.role !== 'customer';

      setBusy(true);
      try {
        if (mine) {
          if (asGuest) {
            await seatApi.unlockGuestSeats(trip.id, [seat.id]);
          } else {
            await seatApi.unlockSeats(trip.id, [seat.id]);
          }
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
          const result = asGuest
            ? await seatApi.lockGuestSeats(trip.id, [seat.id])
            : await seatApi.lockSeats(trip.id, [seat.id]);
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
          if (asGuest) {
            // La sesión guest murió o ya no existe: el servidor no reconoce
            // ningún lock propio, así que la selección completa queda vencida.
            toast.error('Tu selección expiró. Elige tus asientos de nuevo.');
            setPhase('expired');
            return;
          }
          toast.error('Tu sesión expiró. Inicia sesión de nuevo.');
          router.push(`/login?redirect=${authRedirect}`);
        } else if (e instanceof ApiError && e.code === 'CUSTOMER_REQUIRED') {
          // Seguridad: la sesión autenticada no puede gestionar asientos en
          // los endpoints autenticados. Nunca mandar al login (la cuenta YA
          // está autenticada) — la selección de asientos es guest por diseño.
          toast.error(
            'Solo las cuentas de cliente pueden reservar con esta sesión.',
          );
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
    [authRedirect, busy, lock, router, trip],
  );

  /**
   * "Cambiar asientos": libera TODO y reinicia la selección en esta misma
   * pantalla (el viaje y la URL `?trip=` no cambian; /viajes/[id] ya no forma
   * parte del flujo). Si no hay asientos no hay nada que liberar.
   */
  const changeSeats = useCallback(async () => {
    if (!lock || lock.reservation_id) return;

    if (lock.seats.length > 0) {
      const user = authRef.current?.user;
      const asGuest = !user || user.role !== 'customer';
      setBusy(true);
      try {
        await (asGuest
          ? seatApi.unlockGuestSeats(lock.trip_id, undefined)
          : seatApi.unlockSeats(lock.trip_id));
      } catch (e) {
        // 401/403: la sesión ya no existe o no corresponde a un customer;
        // en el servidor no queda nada propio que liberar.
        if (
          !(e instanceof ApiError && (e.status === 401 || e.status === 403))
        ) {
          toast.error(
            getApiErrorMessage(
              e,
              'No pudimos liberar tus asientos. Intenta de nuevo.',
            ),
          );
          return;
        }
      } finally {
        setBusy(false);
      }
    }

    clearLockState();
    setLock((prev) =>
      prev ? { ...prev, seats: [], passengers: [], lock_expires_at: '' } : prev,
    );
    setPassengers([]);
    setFieldErrors([]);
    setCreateError(null);
    // El mapa se refresca: los asientos liberados pueden haber sido tomados.
    void refreshTrip();
    toast.success('Selección liberada. Elige tus asientos de nuevo.');
  }, [lock, refreshTrip]);

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
              if (lock) {
                // Vuelve al checkout con el viaje: el mapa queda limpio para
                // elegir de nuevo (el efecto se re-ejecuta aunque la URL ya
                // tuviera el mismo ?trip=).
                router.push(`/reservas/nueva?trip=${lock.trip_id}`);
                setVerifyAttempt((attempt) => attempt + 1);
              } else {
                router.push('/viajes');
              }
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

  if (phase === 'unpriced') {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb]">
            <AlertTriangle size={24} strokeWidth={1.75} className="text-[#92400e]" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold text-brand-navy">
            Reserva no disponible
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            {UNPRICED_MESSAGE}
          </p>
          <Link
            href="/viajes"
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Ver otros viajes
          </Link>
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

  const lockedAfterCreation = !!lock.reservation_id;
  const formLocked = busy || lockedAfterCreation;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
      <header className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase text-brand-muted">
              Tu reserva
            </p>
            <h1 className="mt-2 text-[28px] font-extrabold leading-tight text-brand-navy">
              Completa tu reserva
            </h1>
            <p className="mt-2 text-sm text-brand-muted">
              Asientos, pasajeros, pago y comprobante en una sola pantalla.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void changeSeats()}
            disabled={formLocked}
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
      </header>

      {lock.lock_expires_at ? (
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-[#fffbeb] px-4 py-3 text-sm text-[#92400e]">
          <LockCountdown
            expiresAt={lock.lock_expires_at}
            onExpired={handleExpired}
          />
          <span>Los asientos están retenidos mientras completas tu reserva.</span>
        </div>
      ) : null}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-6">
          <section
            id="seat-map"
            aria-label="Asientos"
            className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
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
                onToggleSeat={
                  lockedAfterCreation
                    ? undefined
                    : (seatCode) => {
                        if (!busy) void handleToggleSeat(seatCode);
                      }
                }
              />
            </div>

            <p className="mt-4 text-center text-xs text-brand-muted">
              {lockedAfterCreation
                ? 'Tu reserva ya está creada: los asientos no pueden modificarse.'
                : lock.seats.length === 0
                  ? 'Elige tus asientos en el mapa: los bloqueamos por 15 minutos mientras completas tu reserva.'
                  : 'Tus asientos quedan bloqueados mientras completas el formulario.'}
            </p>
          </section>

          <section
            aria-label="Pasajeros"
            className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                Datos de los pasajeros
              </h2>
              <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
                {passengers.length} pasajero{passengers.length === 1 ? '' : 's'}
              </span>
            </div>

            {passengers.length === 0 ? (
              <div className="mt-5 flex flex-col items-center rounded-2xl border border-dashed border-black/[0.08] bg-[#f8fafc] px-6 py-10 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9]">
                  <Users
                    size={24}
                    strokeWidth={1.75}
                    className="text-brand-navy"
                    aria-hidden="true"
                  />
                </div>
                {lock.seats.length === 0 ? (
                  <>
                    <p className="mt-4 text-[17px] font-semibold text-brand-navy">
                      Selecciona tus asientos
                    </p>
                    <p className="mt-2 max-w-md text-sm text-brand-muted">
                      Elige al menos un asiento en el mapa para cargar los datos
                      de cada pasajero.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        document
                          .getElementById('seat-map')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                      className="mt-5 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                    >
                      <Ticket size={16} strokeWidth={1.75} aria-hidden="true" />
                      Elegir asientos
                    </button>
                  </>
                ) : (
                  <>
                    <p className="mt-4 text-[17px] font-semibold text-brand-navy">
                      Aún no tienes pasajeros
                    </p>
                    <p className="mt-2 max-w-md text-sm text-brand-muted">
                      Tus asientos están reservados. Actualiza la selección para
                      cargar los datos de cada pasajero.
                    </p>
                    <button
                      type="button"
                      onClick={() => setVerifyAttempt((attempt) => attempt + 1)}
                      className="mt-5 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                    >
                      <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                      Actualizar selección
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                {passengers.map((passenger, index) => (
                  <PassengerCard
                    key={passenger.seat_id}
                    seatCode={seatCodeFor(passenger.seat_id)}
                    index={index}
                    passenger={passenger}
                    errors={fieldErrors}
                    disabled={formLocked}
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
            )}
          </section>

          <section
            aria-label="Pago"
            className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                Pago
              </h2>
              {lock.reservation_id ? (
                <span className="rounded-full bg-[#ecfdf5] px-3 py-1 text-[11px] font-semibold text-[#059669]">
                  Reserva creada
                </span>
              ) : null}
            </div>

            {lock.reservation_id ? (
              <div className="mt-5">
                {agencyName ? (
                  <div className="rounded-[10px] bg-[#ecfdf5] px-4 py-3">
                    <p className="text-sm font-semibold text-[#059669]">
                      Pagas directamente a {agencyName}
                    </p>
                    <p className="mt-1 text-xs text-brand-muted">
                      Nómadas organiza la reserva; la transferencia se realiza a
                      la cuenta verificada de la agencia.
                    </p>
                  </div>
                ) : null}
                <p className="mt-3 text-sm text-brand-muted">
                  Aquí aparecerán las opciones de pago. Tus asientos están
                  confirmados y tus pasajeros quedaron guardados.
                </p>
              </div>
            ) : auth?.loading ? (
              <div className="mt-5 flex items-center gap-2">
                <LoaderCircle
                  size={20}
                  strokeWidth={1.75}
                  className="animate-spin text-brand-muted"
                  aria-hidden="true"
                />
                <p className="text-sm text-brand-muted">
                  Verificando tu sesión…
                </p>
              </div>
            ) : !auth?.user ? (
              <div className="mt-5">
                <p className="text-sm text-brand-muted">
                  Para continuar con el pago, debes iniciar sesión.
                </p>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <Link
                    href={`/login?redirect=${authRedirect}`}
                    className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                  >
                    <LogIn size={16} strokeWidth={1.75} aria-hidden="true" />
                    Iniciar sesión
                  </Link>
                  <Link
                    href={`/register?redirect=${authRedirect}`}
                    className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                  >
                    <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
                    Registrarse
                  </Link>
                </div>
              </div>
            ) : auth.user.role !== 'customer' ? (
              // Cuenta autenticada que no es customer (p. ej. superadmin):
              // lockea como guest, pero el backend responde 403
              // CUSTOMER_REQUIRED. Enseñar el motivo en vez del gate de
              // login/registro, que sería engañoso: la sesión YA existe.
              <div className="mt-5">
                <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
                  <p className="text-sm font-semibold text-[#92400e]">
                    Solo las cuentas de cliente pueden realizar reservas.
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    Tu sesión actual no es una cuenta de cliente, así que no
                    puedes confirmar esta reserva.
                  </p>
                </div>
              </div>
            ) : !lock.agency_id ? (
              <p className="mt-5 text-sm text-brand-muted">
                Este viaje no tiene una oferta de agencia disponible. Elige otro
                viaje para continuar.
              </p>
            ) : createError ? (
              <div className="mt-5">
                <p
                  role="alert"
                  className="rounded-[10px] bg-[#fef2f2] px-4 py-3 text-sm text-[#ef4444]"
                >
                  {createError}
                </p>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy || creating}
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {creating ? (
                    <LoaderCircle
                      size={16}
                      strokeWidth={1.75}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {creating ? 'Confirmando tu reserva…' : 'Reintentar'}
                </button>
              </div>
            ) : lock.seats.length === 0 ? (
              <p className="mt-5 text-sm text-brand-muted">
                Selecciona al menos un asiento para continuar con el pago.
              </p>
            ) : (
              <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-brand-muted">
                  Revisa los datos de los pasajeros y confirma para crear tu
                  reserva con la agencia.
                </p>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy || creating}
                  className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {creating ? (
                    <LoaderCircle
                      size={16}
                      strokeWidth={1.75}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : null}
                  {creating ? 'Confirmando tu reserva…' : 'Confirmar y pagar'}
                </button>
              </div>
            )}
          </section>

          {lock.reservation_id ? (
            <section
              aria-label="Comprobante"
              className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Comprobante de pago
                </h2>
                <span className="rounded-full bg-[#ecfdf5] px-3 py-1 text-[11px] font-semibold text-[#059669]">
                  Confirmada
                </span>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-brand-muted">Viaje</dt>
                  <dd className="text-right font-semibold text-brand-navy">
                    {trip.route.origin} → {trip.route.destination}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-brand-muted">Salida</dt>
                  <dd className="text-right font-semibold text-brand-navy">
                    {formatDateTimeShort(trip.departure_time)} ·{' '}
                    {formatTime12h(trip.departure_time)}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-brand-muted">Agencia</dt>
                  <dd className="text-right font-semibold text-brand-navy">
                    {agencyName ?? '—'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-brand-muted">Asientos</dt>
                  <dd className="text-right font-semibold text-brand-navy">
                    {seatCodes.join(', ')}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-brand-muted">Referencia</dt>
                  <dd className="text-right font-semibold text-brand-navy">
                    {lock.reservation_id}
                  </dd>
                </div>
              </dl>

              <p className="mt-5 text-[12px] font-medium uppercase text-brand-muted">
                Pasajeros
              </p>
              <ul className="mt-2 space-y-2">
                {passengers.map((passenger) => (
                  <li
                    key={passenger.seat_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2.5 text-sm"
                  >
                    <span className="font-medium text-brand-navy">
                      {passengerFullName(passenger)} · {passenger.document} ·
                      asiento {seatCodeFor(passenger.seat_id)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 flex items-center justify-between rounded-[10px] bg-[#f1f5f9] px-4 py-3">
                <span className="text-sm font-semibold text-brand-navy">
                  Importe
                </span>
                <span className="text-[17px] font-extrabold leading-none text-brand-navy">
                  {totalCents !== null
                    ? `${formatSeatPrice(totalCents)} por ${passengers.length} asientos`
                    : 'Precio no disponible'}
                </span>
              </div>
            </section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-24">
          <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
              Resumen de tu reserva
            </h2>

            <p className="mt-4 text-[17px] font-semibold text-brand-navy">
              {trip.route.origin} → {trip.route.destination}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-brand-muted">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" />
                {formatDateTimeShort(trip.departure_time)}
              </span>
              <span>{formatTime12h(trip.departure_time)}</span>
              {agencyName ? <span>{agencyName}</span> : null}
            </p>

            <p className="mt-4 rounded-[10px] bg-[#f1f5f9] px-3 py-2 text-sm font-semibold text-brand-navy">
              {lock.seats.length === 0
                ? 'Aún no has seleccionado asientos'
                : `${lock.seats.length} pasajero${
                    lock.seats.length === 1 ? '' : 's'
                  } · asientos ${seatCodes.join(', ')}`}
            </p>

            {passengers.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {passengers.map((passenger) => (
                  <li
                    key={passenger.seat_id}
                    className="flex items-start justify-between gap-2 text-sm"
                  >
                    <span className="font-medium text-brand-navy">
                      {passengerFullName(passenger)}
                    </span>
                    <span className="text-brand-muted">
                      {passenger.document} · Asiento{' '}
                      {seatCodeFor(passenger.seat_id)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mt-4 flex items-center justify-between rounded-[10px] bg-[#f1f5f9] px-4 py-3">
              <span className="text-sm font-semibold text-brand-navy">
                {lock.seats.length === 0
                  ? 'Sin asientos'
                  : `Total ${lock.seats.length} asiento${
                      lock.seats.length === 1 ? '' : 's'
                    }`}
              </span>
              <span className="text-[24px] font-extrabold leading-none text-brand-navy">
                {lock.seats.length > 0 && totalCents !== null
                  ? formatSeatPrice(totalCents)
                  : '—'}
              </span>
            </div>
          </section>

          <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p className="flex items-center gap-2 text-sm font-semibold text-brand-navy">
              <ShieldCheck
                size={16}
                strokeWidth={1.75}
                className="text-[#10b981]"
                aria-hidden="true"
              />
              Pago seguro y trazable
            </p>
            <p className="mt-2 text-xs text-brand-muted">
              Guardamos los datos y el comprobante para acompañarte ante
              cualquier incidencia.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}

/**
 * `useSearchParams` exige un Suspense boundary (Next lo valida en build).
 * El contenido se monta síncrono en cliente, así que el fallback solo se ve
 * en el prerender del shell estático.
 */
export default function NewReservationPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
          <div className="animate-pulse" aria-hidden="true">
            <div className="h-4 w-56 rounded-full bg-black/[0.06]" />
            <div className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="h-5 w-48 rounded bg-black/[0.06]" />
              <div className="mt-4 h-64 w-full rounded-2xl bg-black/[0.06]" />
            </div>
          </div>
          <span className="sr-only">Cargando tu reserva…</span>
        </main>
      }
    >
      <NewReservationContent />
    </Suspense>
  );
}
