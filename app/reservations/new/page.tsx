'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  Circle,
  LoaderCircle,
  LogIn,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Ticket,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  checkoutApi,
  publicApi,
  seatApi,
  type CheckoutAttemptStatus,
  type CreateCheckoutAttemptResult,
  type PublicTripDetail,
  type PublicTripSeat,
  type SubmitCheckoutProofResult,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatDateTimeShort } from '@/lib/timezone';
import { formatSeatPrice, TRIP_PRICE_PENDING_LABEL } from '@/lib/price';
import { BusLayout } from '@/components/bus/BusLayout';
import { LockCountdown } from '@/components/booking/LockCountdown';
import { PassengerCard } from '@/components/booking/PassengerCard';
import { ProofUploader, newIdempotencyKey } from '@/components/booking/ProofUploader';
import { PaymentMethodSection } from '@/components/booking/PaymentMethodSection';
import { AgencyContactLinks } from '@/components/booking/AgencyContactLinks';
import { whatsappHref, copyToClipboard } from '@/lib/booking/whatsapp';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { StateIcon } from '@/components/ui/StateIcon';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import {
  clearLockState,
  isValidCheckoutMarker,
  readLockState,
  writeLockState,
  type CheckoutMarker,
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
import { compareSeatCodes, sortSeatCodes } from '@/lib/booking/seat-code';
import { reviewMessage } from '@/lib/booking/review-message';
import { claimPendingGuestLocks } from '@/lib/booking/guest-claim';
import { useSeatLocking } from '@/lib/booking/useSeatLocking';
import {
  subscribeToPurchaseTicket,
  type RealtimeSeatRow,
  type SeatEventType,
} from '@/lib/realtime/subscriptions';

type Phase = 'loading' | 'missing' | 'expired' | 'error' | 'ready';

// Mensaje del error del backend: el RPC sigue validando TRIP_PRICE_MISSING,
// así que "Confirmar y pagar" sobre un viaje sin precio termina aquí.
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
  // Entrada directa del catálogo: `/reservations/new?trip=<id>` carga el viaje
  // y arranca el checkout con 0 asientos (el mapa está en la propia pantalla).
  const searchParams = useSearchParams();
  const tripParam = searchParams.get('trip');
  const authLoading = auth?.loading ?? false;
  // Destino de vuelta tras login/registro: conserva `?trip=` para no perder
  // la entrada directa desde el catálogo.
  const authRedirect = encodeURIComponent(
    tripParam ? `/reservations/new?trip=${tripParam}` : '/reservations/new',
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
  // Fase 2 (Bug 3): el backend rechazó la creación con
  // CHECKOUT_AGENCY_NOT_ASSIGNED. Estado de recuperación PROPIO, separado de
  // createError: esta rama nunca ofrece el botón "Reintentar", que
  // reenviaría el mismo agency_id en bucle. Solo se limpia con un refetch
  // exitoso de las ofertas (reconciliación explícita) o al iniciar una
  // entrada nueva; un error de red lo conserva.
  const [agencyMismatch, setAgencyMismatch] = useState(false);
  // Evita refetch duplicado de ofertas desde el botón de recuperación.
  const [refreshingOffers, setRefreshingOffers] = useState(false);
  // Dedupe en vuelo: evita doble POST por Strict Mode, re-renders o dos
  // clics concurrentes. El backend además es idempotente (201 → 200).
  const creatingRef = useRef(false);
  // MKT-007: el intento de compra gobierna la pantalla. Un marcador que no
  // pasa `isValidCheckoutMarker` nunca llega aquí (se descarta al leer).
  const checkoutMarker = isValidCheckoutMarker(lock?.checkout)
    ? lock?.checkout
    : null;
  const attemptCreated = !!lock?.attempt_id;
  // Un intento existente congela asientos, locks y re-creación: la reserva
  // definitiva solo nace cuando la agencia verifica el comprobante.
  const checkoutActive = attemptCreated;
  const awaitingReview = checkoutMarker?.status === 'pending_review';
  const checkoutRejected = checkoutMarker?.status === 'rejected';
  const checkoutActiveRef = useRef(false);
  checkoutActiveRef.current = checkoutActive;

  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Aprobación observada en el SERVIDOR. No se persiste en la LockState: la
  // única fuente de verdad de "pago aprobado" es `getAttempt` (MKT-007).
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  // MKT-007.1: estado CRUDO del intento, tal como lo devuelve
  // `checkoutApi.getAttempt`. NO se deriva del marcador local
  // (`checkoutMarker.status`) porque el marcador colapsa `rejected_final` →
  // `rejected` y `verified` → `created`. Fuente: se rehidrata en cada
  // refresh de la pantalla (verify() llama a `getAttempt`), se actualiza al
  // crear/enviar comprobante y se limpia al cancelar o volver a cero.
  const [checkoutStatus, setCheckoutStatus] =
    useState<CheckoutAttemptStatus | null>(null);
  // M-1: estado terminal REAL del intento, tomado del estado crudo
  // (getAttempt) y NO del marcador ni de remaining_submissions. El
  // rechazo por ventana vencida (Tour 090) deja rejected_final con
  // proof_count < 3, y la vista devuelve remaining_submissions > 0.
  // Cuando es true, el uploader de comprobantes queda bloqueado en
  // todos sus caminos, prevaleciendo sobre remaining_submissions,
  // selectedMethodId y coordinatedPayment.
  const checkoutFinal = checkoutStatus === 'rejected_final';
  // MKT-007.4: canal de pago elegido para el intento. La fuente de verdad
  // es el servidor (getPaymentMethods / selectPaymentMethod); este estado
  // solo gobierna si se muestra el uploader del comprobante.
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  // MKT-008: el pago se coordina directamente con la agencia y el
  // uploader de comprobante se habilita sin exigir selección de canal.
  // Dos escenarios, ambos notificados por PaymentMethodSection al cargar
  // getPaymentMethods: (a) la agencia no tiene canales activos; (b) modo
  // agency_direct congelado tras un rechazo (status='rejected' sin
  // selección; la agencia puede tener canales activos ahora). La fuente
  // de verdad es el servidor; este estado solo gobierna el uploader.
  const [coordinatedPayment, setCoordinatedPayment] = useState(false);

  // MKT-007.4: oferta de la agencia elegida. `payment_methods_available`
  // solo bloquea el checkout cuando el backend lo devuelve en false
  // explícito; si el campo no existe (respuesta antigua) se asume true y
  // el guard del backend (409) es la autoridad. Declarado ANTES de
  // handleCreate porque va en su dep array.
  const selectedOffer = useMemo(() => {
    if (!lock || !trip) return null;
    return (
      trip.offers.find((offer) => offer.agency_id === lock.agency_id) ?? null
    );
  }, [lock, trip]);
  const agencyWithoutChannels = selectedOffer?.payment_methods_available === false;
  // MKT-008: contactos públicos de la agencia (E.164). Sin contactos se
  // cae al teléfono legado; el array vacío conserva el estado actual.
  const offerContacts = selectedOffer?.contacts ?? [];
  const offerWhatsApp = whatsappHref(selectedOffer?.phone ?? null);

  // Fase 2 (Bug 3): reconciliación de la agencia persistida contra las
  // ofertas VIGENTES del viaje. El detalle del viaje solo incluye agencias
  // activas y asignadas, así que una agencia desasignada o inactiva desaparece
  // de `offers[]` y este flag queda en true sin depender del POST. Con `trip`
  // sin cargar no se decide nada: el guard de handleCreate ya impide el POST,
  // y un fetch fallido jamás se interpreta como "agencia desasignada".
  const agencyStale = useMemo(() => {
    if (!lock || !trip || !lock.agency_id) return false;
    return !trip.offers.some((offer) => offer.agency_id === lock.agency_id);
  }, [lock, trip]);

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
        setTrip(response.trip);
        setLock({
          trip_id: response.trip.id,
          // Solo puede fijarse sin elección la oferta ÚNICA del viaje: es la
          // única agencia válida, no una elección arbitraria. Con varias
          // ofertas (o ninguna) NO se pincha offers[0] en silencio: el usuario
          // elige en el selector integrado en ESTA pantalla (la ruta de
          // detalle /trips/[id] fue eliminada; el catálogo siempre enlaza
          // a /reservations/new?trip=).
          agency_id:
            response.trip.offers.length === 1
              ? response.trip.offers[0].agency_id
              : null,
          seats: [],
          lock_expires_at: '',
          passengers: [],
        });
        setPassengers([]);
        setFieldErrors([]);
        setCreateError(null);
        // Entrada nueva de la pantalla: el estado de recuperación de agencia
        // pertenece al ciclo anterior (se recalcula solo con los datos vigentes).
        setAgencyMismatch(false);
        setVerifiedAt(null);
        setCheckoutStatus(null);
        setSelectedMethodId(null);
        setCoordinatedPayment(false);
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
        // MKT-009: con un intento de compra en curso los locks pertenecen a
        // la compra (seats.checkout_attempt_id), no a este borrador: un
        // unlock dispararía el trigger de 087 y destruiría la compra en
        // revisión. La selección local se retira (el usuario navegó
        // voluntariamente a otro viaje), la compra sigue viva en el
        // servidor y se avisa por dónde seguirla. Solo se libera la
        // selección libre, sin intento.
        if (stored.attempt_id) {
          toast(
            'Tu compra en curso sigue activa. Síguela en Mis compras.',
          );
          clearLockState();
          await startFresh(tripParam);
          return;
        }
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

      // MKT-010: el skeleton solo en la primera entrada. Una revalidación
      // (Realtime del intento o countdown) conserva la pantalla lista y
      // repinta los datos del servidor sin interrumpir al usuario.
      if (!stored.attempt_id) setPhase('loading');
      setError(null);

      // MKT-007: con un intento de compra existente la pantalla se restaura
      // desde el SERVIDOR, no desde el marcador local. El intento es quien
      // dueña de los asientos, así que no se reclama la sesión guest ni se
      // revalidan los locks temporales (eso borraría la compra en revisión).
      // Tampoco se consulta ninguna URL pública del comprobante: la API no
      // devuelve una.
      if (stored.attempt_id) {
        try {
          const [tripResponse, attempt] = await Promise.all([
            publicApi.tripDetail(stored.trip_id),
            checkoutApi.getAttempt(stored.attempt_id),
          ]);
          if (cancelled) return;

          // Ventanas terminales: el intento ya no puede avanzar y no queda
          // nada que seguir en esta pantalla. Las liberaciones siguen la regla
          // "el estado del usuario no se limpia hasta confirmación": aquí hay
          // confirmación explícita del servidor de que la compra cerró.
          if (attempt.status === 'expired' || attempt.status === 'cancelled') {
            clearLockState();
            await startFresh(stored.trip_id);
            return;
          }

          const marker: CheckoutMarker = {
            status:
              attempt.status === 'pending_review'
                ? 'pending_review'
                : attempt.status === 'rejected' ||
                    attempt.status === 'rejected_final'
                  ? 'rejected'
                  : 'created',
            attempt_id: attempt.attempt_id,
            submitted_at: attempt.proof_submitted_at ?? undefined,
            proof_count: attempt.proof_count,
            remaining_submissions: attempt.remaining_submissions,
            expires_at: attempt.expires_at,
            rejection_reason: attempt.rejection_reason ?? undefined,
          };
          const restored: LockState = {
            ...stored,
            // El intento sustituye al lock original: la ventana que gobierna
            // la pantalla es la que calculó el backend.
            lock_expires_at: attempt.expires_at,
            checkout: marker,
          };
          setTrip(tripResponse.trip);
          setLock(restored);
          setPassengers(reconcilePassengers(restored, stored.passengers));
          setFieldErrors([]);
          setCreateError(null);
          setVerifiedAt(attempt.status === 'verified' ? (attempt.verified_at ?? '') : null);
          setCheckoutStatus(attempt.status);
          setPhase('ready');
          writeLockState({ ...restored, passengers: restored.passengers });
        } catch (e) {
          if (cancelled) return;
          if (e instanceof ApiError && e.status === 404) {
            // El intento ya no existe o no es tuyo: no hay nada que reclamar.
            clearLockState();
            await startFresh(stored.trip_id);
            return;
          }
          setPhase('error');
          setError(
            getApiErrorMessage(
              e,
              'No pudimos cargar tu compra. Intenta de nuevo.',
            ),
          );
        }
        return;
      }

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

  // Ventana del INTENTO, no del lock original: mientras el intento exista la
  // expiración no puede borrar la revisión ni devolver al mapa. Se reconcilia
  // con el servidor una sola vez por ventana para refrescar el estado real.
  const expiryHandledFor = useRef<string | null>(null);

  const handleExpired = useCallback(() => {
    if (checkoutActiveRef.current) {
      const key =
        lock?.checkout?.expires_at ?? lock?.lock_expires_at ?? 'unknown';
      if (expiryHandledFor.current === key) return;
      expiryHandledFor.current = key;
      setVerifyAttempt((current) => current + 1);
      return;
    }
    setPhase((current) => (current === 'ready' ? 'expired' : current));
  }, [lock]);

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
      if (err.code === 'CHECKOUT_AGENCY_NOT_ASSIGNED') {
        // Fase 2 (Bug 3): el backend (autoridad) confirmó que la agencia
        // persistida ya no pertenece al viaje. NUNCA el createError genérico,
        // cuyo botón "Reintentar" reenviaría el mismo agency_id en bucle.
        // No hay estado de reserva que limpiar: el 404 ocurre antes de crear
        // el intento. El cliente se recupera con un refetch explícito de las
        // ofertas o eligiendo otra agencia desde el viaje.
        setAgencyMismatch(true);
        return;
      }
      if (err.code === 'TRIP_PRICE_MISSING') {
        setCreateError(UNPRICED_MESSAGE);
        return;
      }
      if (err.code === 'AGENCY_NO_ACTIVE_PAYMENT_METHODS') {
        // MKT-007.4: la agencia perdió sus canales entre la oferta y el
        // POST. El mensaje del backend ya es el copy aprobado.
        setCreateError(
          err.message ||
            'Esta agencia aún no tiene un método de pago configurado. Contacta a la agencia para continuar.',
        );
        return;
      }
      if (err.status === 429) {
        setCreateError(
          'Demasiados intentos. Espera un momento y vuelve a intentarlo.',
        );
        return;
      }
      setCreateError(
        err.message || 'No pudimos iniciar tu compra. Intenta de nuevo.',
      );
      return;
    }
    setCreateError(
      getApiErrorMessage(err, 'No pudimos iniciar tu compra. Intenta de nuevo.'),
    );
  }, []);

  // ─── Creación del intento de compra (MKT-007) ────────────────────────
  // Disparada por "Continuar al pago". NO crea reserva: crea un
  // `checkout_attempt` que retiene los asientos mientras la agencia revisa.
  // Guards: attempt_id (refresh/back-forward), ref en vuelo (Strict Mode,
  // re-renders, doble clic) y validación de pasajeros ANTES del POST (§14).
  const handleCreate = useCallback(async () => {
    if (!lock || creatingRef.current || lock.attempt_id) return;
    const sessionUser = authRef.current?.user;
    if (!sessionUser) return; // gate: sin sesión no hay POST
    if (sessionUser.role !== 'customer') return; // backend: CUSTOMER_REQUIRED
    if (!lock.agency_id) return; // sin oferta de agencia no hay payload válido
    // Fase 2 (Bug 3): reconciliación de agencia — jamás se reenvía un
    // agency_id que los datos vigentes marcaron como fuera de la oferta del
    // viaje o que el backend rechazó con CHECKOUT_AGENCY_NOT_ASSIGNED.
    if (agencyStale || agencyMismatch) return;
    // MKT-008: la agencia sin canales activos ya NO bloquea la creación
    // del intento; el pago coordinado se resuelve al subir el comprobante.
    // Sin precio publicado no hay POST: el payload jamás lleva precio (lo
    // decide el RPC) y el backend respondería TRIP_PRICE_MISSING. La UI ya
    // oculta el CTA, pero el guard cubre handlers directos y restauraciones.
    if (!trip || trip.seat_price === null) return;
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
    // Clave estable ANTES del POST: si la respuesta se pierde, el reintento
    // reutiliza la MISMA `Idempotency-Key` y el RPC devuelve el intento
    // existente en lugar de crear un segundo. Se guarda también en el estado
    // React (no solo en sessionStorage): un reintento en la MISMA sesión lee
    // `lock` y debe reutilizar la clave, no regenerarla (Fase 3).
    const attemptKey = snapshot.attempt_key ?? newIdempotencyKey();
    writeLockState({ ...snapshot, attempt_key: attemptKey });
    setLock((prev) => (prev ? { ...prev, attempt_key: attemptKey } : prev));

    try {
      const result: CreateCheckoutAttemptResult = await checkoutApi.createAttempt(
        {
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
        },
        attemptKey,
      );
      const marker: CheckoutMarker = {
        status:
          result.status === 'pending_review'
            ? 'pending_review'
            : result.status === 'rejected'
              ? 'rejected'
              : 'created',
        attempt_id: result.attempt_id,
        proof_count: result.proof_count,
        remaining_submissions: Math.max(1, 3 - result.proof_count),
        expires_at: result.expires_at,
      };
      // Persistir ANTES del setState: si el usuario refresca justo aquí,
      // LockState ya tiene el intento y no se vuelve a POSTear (§14).
      writeLockState({
        ...snapshot,
        attempt_key: attemptKey,
        attempt_id: result.attempt_id,
        lock_expires_at: result.expires_at,
        checkout: marker,
      });
      setLock((prev) =>
        prev
          ? {
              ...prev,
              attempt_key: attemptKey,
              attempt_id: result.attempt_id,
              lock_expires_at: result.expires_at,
              checkout: marker,
            }
          : prev,
      );
      setFieldErrors([]);
      setCreateError(null);
      setCheckoutStatus(result.status);
      // Nuevo intento: el canal de pago se re-hidrata desde el servidor en
      // PaymentMethodSection; no arrastramos la elección del intento previo.
      setSelectedMethodId(null);
      setCoordinatedPayment(false);
      toast.success('Compra iniciada. Ahora envía tu comprobante de pago.');
    } catch (err: unknown) {
      handleCreateError(err);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [handleCreateError, lock, passengers, trip, agencyStale, agencyMismatch]);

  // ─── Comprobante de pago (MKT-007) ───────────────────────────────────
  // El marcador se persiste con la LockState y solo indica que la interfaz
  // registró el envío: la compra nunca se pinta como pagada ni confirmada.
  const persistCheckout = useCallback(
    (checkout: CheckoutMarker) => {
      if (!lock) return;
      const next: LockState = {
        ...lock,
        passengers,
        checkout,
        lock_expires_at: checkout.expires_at ?? lock.lock_expires_at,
      };
      writeLockState(next);
      setLock((prev) => (prev ? { ...next } : prev));
    },
    [lock, passengers],
  );

  const handleProofSubmitted = useCallback(
    (result: SubmitCheckoutProofResult) => {
      persistCheckout({
        status: 'pending_review',
        attempt_id: result.attempt_id,
        submitted_at: new Date().toISOString(),
        proof_count: result.proof_count,
        remaining_submissions: result.remaining_submissions,
        expires_at: result.expires_at,
      });
      setCheckoutStatus('pending_review');
      toast.success('Comprobante enviado. Tu pago está pendiente de revisión.');
    },
    [persistCheckout],
  );

  const handleAlreadySubmitted = useCallback(() => {
    // El servidor ya tenía el comprobante: conservar la revisión sin pedir
    // un segundo envío y sin inventar ids que esta respuesta no trajo.
    if (!lock?.attempt_id) return;
    persistCheckout({
      status: 'pending_review',
      attempt_id: lock.attempt_id,
      submitted_at: lock.checkout?.submitted_at,
      proof_count: lock.checkout?.proof_count,
      remaining_submissions: lock.checkout?.remaining_submissions,
      expires_at: lock.checkout?.expires_at,
    });
    setCheckoutStatus('pending_review');
    toast.success('Tu comprobante ya estaba enviado y sigue en revisión.');
  }, [lock, persistCheckout]);

  // ─── Cancelación del intento (acción destructiva → modal) ────────────
  const handleCancelAttempt = useCallback(async () => {
    if (!lock?.attempt_id || cancelling) return;
    setCancelling(true);
    try {
      const result = await checkoutApi.cancelAttempt(lock.attempt_id);
      setConfirmCancel(false);
      // Confirmación visual explícita del servidor: recién ahí se limpia la
      // selección. La pantalla vuelve al mapa con 0 asientos (empty state con
      // CTA: elegir de nuevo) en lugar de a un estado "missing".
      clearLockState();
      setLock((prev) =>
        prev
          ? {
              trip_id: prev.trip_id,
              agency_id: prev.agency_id,
              seats: [],
              lock_expires_at: '',
              passengers: [],
            }
          : null,
      );
      setPassengers([]);
      setFieldErrors([]);
      setCreateError(null);
      setVerifiedAt(null);
      setCheckoutStatus(null);
      setSelectedMethodId(null);
      setCoordinatedPayment(false);
      setPhase((current) => (current === 'ready' ? 'ready' : 'missing'));
      toast.success(
        result.status === 'expired'
          ? 'Esta compra ya expiró. Tus asientos quedaron libres.'
          : result.already_cancelled
            ? 'Esta compra ya estaba cancelada. Tus asientos quedaron libres.'
            : `Compra cancelada. Liberamos ${result.freed_seats} asiento${
                result.freed_seats === 1 ? '' : 's'
              }.`,
      );
      // La realtime (`useSeatLocking`) propaga locked → available a los mapas.
    } catch (e) {
      toast.error(
        getApiErrorMessage(
          e,
          'No pudimos cancelar la compra. Intenta de nuevo.',
        ),
      );
    } finally {
      setCancelling(false);
    }
  }, [cancelling, lock]);

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
    // Con el comprobante en revisión la selección ya no se toca: un lock que
    // expira (o lo toman) no puede ni vaciar los asientos ni mostrar el
    // estado expirado.
    if (checkoutActiveRef.current) return;
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

  // Fase 2 (Bug 3): reconciliación explícita desde la rama de recuperación.
  // Solo un fetch EXITOSO decide: el detalle vigente reemplaza el viaje
  // (agencyStale se recalcula solo contra los offers[] nuevos) y el flag de
  // rechazo del backend se libera. Un error de red NO cambia nada — la
  // agencia persistida se conserva y la rama de recuperación permanece; el
  // usuario puede reintentar el botón o salir por "Elegir otra agencia".
  // Declarado fuera de handleCreateError (que la invocaría desde su
  // dep array con referencia a un const posterior → ReferenceError).
  const handleRefreshOffers = useCallback(async () => {
    if (!trip || refreshingOffers) return;
    setRefreshingOffers(true);
    try {
      const fresh = await publicApi.tripDetail(trip.id);
      setTrip(fresh.trip);
      setAgencyMismatch(false);
      toast.success('Ofertas actualizadas.');
    } catch {
      toast.error('No pudimos actualizar las ofertas. Intenta de nuevo.');
    } finally {
      setRefreshingOffers(false);
    }
  }, [refreshingOffers, trip]);

  // Fase 1-corregida: selección de agencia EXPLÍCITA dentro del checkout.
  // Los bloqueos de asiento NO dependen de la agencia (el body de
  // lockSeats/unlockSeats/unlock solo lleva trip_id y seat_ids), así que
  // cambiar de agencia con un lock activo es seguro: no se libera ningún
  // asiento ni se toca la selección. Con un intento creado la agencia queda
  // comprometida: el handler se niega y la sección del selector ni siquiera
  // se renderiza. La persistencia la hace el efecto existente de LockState
  // (solo con ≥1 asiento); el rechazo previo del backend (agencyMismatch)
  // se limpia porque acabas de hacer una elección explícita nueva.
  const handleSelectAgency = useCallback(
    (agencyId: string) => {
      if (!lock || lock.attempt_id) return;
      if (lock.agency_id === agencyId) return;
      setLock((prev) => (prev ? { ...prev, agency_id: agencyId } : prev));
      setAgencyMismatch(false);
    },
    [lock],
  );

  // Fase 3: salida EXPLÍCITA del estado terminal `verified`. El contrato del
  // backend trata verified como cerrado (`['verified','rejected_final',
  // 'expired','cancelled']` bloquean nuevas acciones del intento); aquí solo
  // se separa la OPERACIÓN LOCAL: se retira la LockState de sessionStorage y
  // se re-verifica, de modo que el effect arranca una operación nueva con el
  // `?trip=` de la URL (startFresh reconstruye el draft SIN attempt_id ni
  // attempt_key → handleCreate generará una clave de idempotencia NUEVA y la
  // conservará en los reintentos de esa misma operación). NUNCA se cancela el
  // intento verificado ni se liberan asientos: no hay cancelAttempt ni
  // unlockSeats en este flujo (los asientos verificados pertenecen a la
  // reserva confirmada). No se inicia nada automáticamente al recargar: la
  // restauración sigue pintando la compra verificada en solo lectura.
  const handleNewPurchase = useCallback(() => {
    clearLockState();
    setVerifyAttempt((attempt) => attempt + 1);
  }, []);

  const tripEndedHandledRef = useRef(false);

  const handleTripCancelled = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error('Este viaje fue cancelado. Tu reserva no puede continuar.');
    clearLockState();
    router.push('/trips');
  }, [router]);

  const handleTripCompleted = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error('Este viaje ya fue completado. Tu reserva no puede continuar.');
    clearLockState();
    router.push('/trips');
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

  // MKT-010: la compra en curso también se sigue en vivo. Cuando el
  // servidor la cierra (expiración por cleanup, verificación o rechazo),
  // el evento de Realtime SOLO dispara una revalidación contra
  // `getAttempt`; la autoridad del estado sigue siendo el backend. Así
  // una sesión abierta pinta la expiración sin esperar a un refresh del
  // navegador. Debounce 500 ms, igual que el resto de las suscripciones.
  useEffect(() => {
    const attemptId = lock?.attempt_id;
    const userId = auth?.user?.id ?? null;
    if (!attemptId || !userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = subscribeToPurchaseTicket(userId, attemptId, () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVerifyAttempt((current) => current + 1);
      }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      cleanup();
    };
  }, [lock?.attempt_id, auth?.user?.id]);

  // Si la realtime vació la selección, la compra queda expirada.
  // `lock_expires_at` distingue el estado inicial (0 asientos, sin lock real,
  // entrada fresca desde el catálogo) de una selección realmente perdida.
  // Con un intento de compra creado la selección ya no se vacía (ver
  // handleSeatLost), así que este efecto no puede borrar la revisión.
  useEffect(() => {
    if (checkoutActive) return;
    if (
      phase === 'ready' &&
      lock &&
      lock.seats.length === 0 &&
      lock.lock_expires_at
    ) {
      setPhase('expired');
    }
  }, [phase, lock, checkoutActive]);

  const handleToggleSeat = useCallback(
    async (seatCode: string) => {
      if (!trip || !lock || busy || lock.attempt_id) return;
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
   * "Liberar asientos": libera TODO y reinicia la selección en esta misma
   * pantalla (el viaje y la URL `?trip=` no cambian; /trips/[id] ya no forma
   * parte del flujo). Si no hay asientos no hay nada que liberar.
   */
  const changeSeats = useCallback(async () => {
    if (!lock || lock.attempt_id) return;

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

  // Orden natural (A1, A4, A10), independiente del orden de selección.
  const seatCodes = useMemo(
    () => sortSeatCodes(lock?.seats.map((seat) => seat.seat_code) ?? []),
    [lock],
  );

  // Precio real del viaje: `seat_price` está en centavos COP y el total para
  // N asientos es exactamente seat_price × N. Sin precio publicado no se pinta
  // ningún importe (el RPC además rechaza la reserva con TRIP_PRICE_MISSING).
  const priceMissing = !!trip && trip.seat_price === null;
  const totalCents =
    trip && lock && trip.seat_price !== null
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
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
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
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <StateIcon tone="neutral">
            <Ticket size={24} strokeWidth={1.75} aria-hidden="true" />
          </StateIcon>
          <h1 className="mt-4 text-[24px] font-bold text-brand-navy">
            No tienes una selección activa
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Elige un viaje y tus asientos para comenzar. Los bloqueamos por 15
            minutos mientras completas tus datos.
          </p>
          <Link
            href="/trips"
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
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <StateIcon tone="error">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </StateIcon>
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
                router.push(`/reservations/new?trip=${lock.trip_id}`);
                setVerifyAttempt((attempt) => attempt + 1);
              } else {
                router.push('/trips');
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

  if (phase === 'error' || !trip || !lock) {
    return (
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <StateIcon tone="error">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </StateIcon>
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

  const formLocked = busy || attemptCreated;
  const attemptId = lock.attempt_id;

  // «Cancelar compra» viaja DENTRO del uploader cuando éste está en pantalla,
  // compartiendo fila con «Enviar comprobante» (en mobile se apila); si no hay
  // uploader, queda en su propia fila. `proofVisible` es espejo de las ramas
  // del ternario del comprobante más abajo: true ⇔ se renderiza <ProofUploader/>.
  const proofVisible =
    !verifiedAt &&
    !awaitingReview &&
    !checkoutFinal &&
    !!(selectedMethodId || coordinatedPayment) &&
    (!checkoutRejected || (checkoutMarker?.remaining_submissions ?? 0) > 0);

  // Checklist de progreso del checkout (solo UI): refleja el estado
  // existente del wizard sin alterar su lógica. "Pasajeros" se marca
  // solo con los datos COMPLETOS — la misma validación que exige
  // "Continuar al pago" para mostrar los métodos de pago (los drafts se
  // crean vacíos al elegir asientos, eso no cuenta como completado).
  const progressoPasos = [
    { label: 'Agencia', done: !!lock.agency_id },
    { label: 'Asientos', done: lock.seats.length > 0 },
    {
      label: 'Pasajeros',
      done:
        lock.seats.length > 0 &&
        passengers.length === lock.seats.length &&
        validatePassengers(passengers).length === 0,
    },
    {
      label: 'Comprobante',
      done:
        !!verifiedAt || awaitingReview || (lock.checkout?.proof_count ?? 0) > 0,
    },
  ];

  const cancelCompraButton = (
    <button
      type="button"
      onClick={() => setConfirmCancel(true)}
      disabled={cancelling}
      className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#fef2f2] px-4 py-2.5 text-sm font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {cancelling ? (
        <LoaderCircle
          size={16}
          strokeWidth={1.75}
          className="animate-spin"
          aria-hidden="true"
        />
      ) : null}
      {cancelling ? 'Cancelando compra…' : 'Cancelar compra'}
    </button>
  );

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
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
            Liberar asientos
          </button>
        </div>
      </header>

      {verifiedAt ? (
        // Confirmación visual explícita del servidor: es el único caso en el
        // que se habla de pago aprobado (MKT-007 §7). El bloque de cierre
        // vive en la cabecera para ser lo primero que vea el cliente; dentro
        // de "Comprobante de pago" ya no se repite.
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 26 }}
          className="mt-6 rounded-[10px] bg-[#ecfdf5] px-4 py-4"
        >
          <p className="text-sm font-semibold text-[#059669]">
            Tu pago fue aprobado.
          </p>
          <p className="mt-1 text-xs text-brand-muted">
            La agencia confirmó la transferencia y tu reserva ya está
            confirmada con tus {passengers.length} pasajero
            {passengers.length === 1 ? '' : 's'} en{' '}
            {seatCodes.join(', ')}.
          </p>
          <p className="mt-2 text-xs text-brand-muted">
            Aprobado el {formatDateTimeShort(verifiedAt)}
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleNewPurchase}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Nueva compra
            </button>
            <Link
              href="/trips"
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-5 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Volver al catálogo
            </Link>
          </div>
        </motion.div>
      ) : attemptCreated && (awaitingReview || checkoutRejected) ? (
        // MKT-007.1 + ajuste UX: las salidas de la compra en curso solo
        // aparecen cuando la parte del usuario del flujo TERMINÓ —
        // comprobante enviado (pending_review) o rechazado (rejected y
        // rejected_final vía marcador). Mientras se paga (created) no hay
        // banner de salida: la cabecera cae al LockCountdown de abajo para
        // que la ventana de la compra (heredada del lock, corriendo en el
        // servidor) siempre sea visible; al vencer, handleExpired
        // revalida contra getAttempt.
        // "Nueva compra" retira solo el estado local (sin cancelar el
        // intento ni liberar asientos) y "Ver mis compras" lleva al
        // seguimiento. Cancelar sigue siendo acción propia del bloque de
        // comprobante, nunca de este banner.
        <div className="mt-6 rounded-[10px] bg-[#fffbeb] px-4 py-4 text-sm text-[#92400e]">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {reviewMessage(checkoutStatus)}
          </span>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleNewPurchase}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Nueva compra
            </button>
            <Link
              href="/account/purchases"
              className="inline-flex items-center justify-center gap-2 rounded-[10px] px-2 py-2 text-sm font-semibold text-brand-navy underline-offset-2 transition-colors duration-200 hover:underline"
            >
              Ver mis compras
            </Link>
          </div>
        </div>
      ) : lock.lock_expires_at ? (
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
          {!attemptId ? (
            <section
              id="agency-selector"
              aria-label="Agencia"
              className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Elige la agencia
                </h2>
                {trip.offers.length > 1 ? (
                  <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
                    {trip.offers.length} agencias disponibles
                  </span>
                ) : null}
              </div>

              {trip.offers.length === 0 ? (
                // Viaje CARGADO sin agencias activas: estado informativo con CTA,
                // sin botón de compra. Un error de carga no llega aquí: cae en la
                // pantalla de fase `error`, distinta de este estado vacío.
                <div className="mt-5 rounded-[10px] bg-[#f1f5f9] px-4 py-5 text-center">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-white">
                    <Building2
                      size={20}
                      strokeWidth={1.75}
                      className="text-brand-muted"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-3 text-sm font-semibold text-brand-navy">
                    Este viaje no tiene agencias disponibles para reservar
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    Ninguna agencia está activa en este viaje ahora mismo, así
                    que no puedes iniciar una compra.
                  </p>
                  <Link
                    href="/trips"
                    className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-5 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                  >
                    <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                    Ver otros viajes
                  </Link>
                </div>
              ) : trip.offers.length === 1 &&
                lock.agency_id === trip.offers[0].agency_id ? (
                // Oferta única ya fijada por startFresh (flujo directo sin pasos
                // extra): la agencia solo se IDENTIFICA, nunca se elige en
                // silencio por el cliente.
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#ecfdf5] px-4 py-3">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#059669]">
                    <Building2 size={16} strokeWidth={1.75} aria-hidden="true" />
                    {trip.offers[0].name}
                  </span>
                  <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[#059669]">
                    Única agencia disponible
                  </span>
                </div>
              ) : (
                // 2-3 ofertas activas (o una oferta única que aún no coincide
                // con la selección): elección EXPLÍCITA. Ningún radio se marca
                // si la agencia persistida no pertenece a las ofertas vigentes;
                // nunca se cambia a otra automáticamente.
                <fieldset className="mt-5">
                  <legend className="sr-only">
                    Selecciona la agencia con la que quieres viajar
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {trip.offers.map((offer) => {
                      const selected = lock.agency_id === offer.agency_id;
                      return (
                        <label
                          key={offer.agency_id}
                          className={`flex cursor-pointer items-start gap-3 rounded-[10px] border bg-white px-4 py-3 transition-shadow duration-200 ${
                            selected
                              ? 'border-brand-cyan shadow-[0_0_0_3px_rgba(212,98,43,0.15)]'
                              : 'border-[#e5e7eb] hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]'
                          }`}
                        >
                          <input
                            type="radio"
                            name="checkout-agency"
                            value={offer.agency_id}
                            checked={selected}
                            onChange={() => handleSelectAgency(offer.agency_id)}
                            className="mt-1 h-4 w-4 shrink-0 accent-brand-cyan"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-brand-navy">
                              {offer.name}
                            </span>
                            {selected ? (
                              <span className="mt-1 inline-block rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-[11px] font-semibold text-[#059669]">
                                Seleccionada
                              </span>
                            ) : (
                              <span className="mt-1 block text-xs text-brand-muted">
                                Elegir esta agencia
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {lock.agency_id === null || agencyStale ? (
                    <p className="mt-3 text-xs text-brand-muted">
                      Selecciona una agencia para continuar: no podemos elegir
                      una por ti.
                    </p>
                  ) : null}
                </fieldset>
              )}
            </section>
          ) : null}

          <section
            id="seat-map"
            aria-label="Asientos"
            className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                Elige tus asientos
              </h2>
              <motion.span
                key={lock.seats.length}
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted"
              >
                {lock.seats.length} seleccionado
                {lock.seats.length === 1 ? '' : 's'}
              </motion.span>
            </div>

            <div className="mt-6">
              <BusLayout
                vehicleType={trip.vehicle_type}
                seats={trip.seats}
                selectedSeats={seatCodes}
                onToggleSeat={
                  attemptCreated
                    ? undefined
                    : (seatCode) => {
                        if (!busy) void handleToggleSeat(seatCode);
                      }
                }
              />
            </div>

            <p className="mt-4 text-center text-xs text-brand-muted">
              {attemptCreated
                ? 'Tu compra ya está iniciada: los asientos no pueden modificarse.'
                : lock.seats.length === 0
                  ? 'Elige tus asientos en el mapa: los bloqueamos mientras completas tu reserva.'
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
                <StateIcon tone="neutral">
                  <Users size={24} strokeWidth={1.75} aria-hidden="true" />
                </StateIcon>
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
              {lock.attempt_id ? (
                verifiedAt ? (
                  <span className="rounded-full bg-[#ecfdf5] px-3 py-1 text-[11px] font-semibold text-[#059669]">
                    Pago aprobado
                  </span>
                ) : awaitingReview ? (
                  <span className="rounded-full bg-[#fffbeb] px-3 py-1 text-[11px] font-semibold text-[#92400e]">
                    En revisión
                  </span>
                ) : checkoutRejected ? (
                  <span className="rounded-full bg-[#fef2f2] px-3 py-1 text-[11px] font-semibold text-[#ef4444]">
                    Comprobante rechazado
                  </span>
                ) : (
                  <span className="rounded-full bg-[#ecfdf5] px-3 py-1 text-[11px] font-semibold text-[#059669]">
                    Compra iniciada
                  </span>
                )
              ) : null}
            </div>

            {lock.attempt_id ? (
              <div className="mt-5">
                {agencyName ? (
                  <div className="rounded-[10px] bg-[#ecfdf5] px-4 py-3">
                    <p className="text-sm font-semibold text-[#059669]">
                      Pagas directamente a {agencyName}
                    </p>
                    <p className="mt-1 text-xs text-brand-muted">
                      Nómadas organiza la compra; la transferencia se realiza a
                      la cuenta verificada de la agencia.
                    </p>
                  </div>
                ) : null}
                <p className="mt-3 text-sm text-brand-muted">
                  Tus asientos quedaron retenidos y tus pasajeros están
                  guardados. La reserva definitiva se crea cuando la agencia
                  apruebe tu comprobante.
                </p>
              </div>
            ) : priceMissing ? (
              // Viaje sin precio publicado: no hay reserva ni pago posible.
              // El backend rechazaría con TRIP_PRICE_MISSING; aquí se corta
              // el flujo antes de cualquier POST y sin tocar el TTL del bloqueo.
              <div className="mt-5">
                <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
                  <p className="text-sm font-semibold text-[#92400e]">
                    Este viaje todavía no tiene un precio publicado.
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    No es posible reservarlo ni enviar un pago hasta que la
                    agencia defina el precio por asiento. Tus asientos siguen
                    bloqueados y la selección se conserva hasta que expire.
                  </p>
                </div>
                <Link
                  href="/trips"
                  className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                >
                  <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                  Ver otros viajes
                </Link>
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
              trip && trip.offers.length > 1 ? (
                // Varias ofertas sin elección aún: NUNCA se fija una en
                // silencio y NUNCA se deriva a /trips/[id]. El selector vive
                // en esta misma pantalla (sección "Elige la agencia").
                <div className="mt-5">
                  <p className="text-sm text-brand-muted">
                    Este viaje opera con varias agencias y no podemos elegir una
                    por ti. Elige con quién quieres viajar en la sección «Elige
                    la agencia» de esta página para continuar.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      document
                        .getElementById('agency-selector')
                        ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
                    }
                    className="mt-3 inline-flex items-center rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                  >
                    Elegir agencia
                  </button>
                </div>
              ) : (
                <p className="mt-5 text-sm text-brand-muted">
                  Este viaje no tiene una oferta de agencia disponible. Elige otro
                  viaje para continuar.
                </p>
              )
            ) : trip && !attemptId && (agencyStale || agencyMismatch) ? (
              // Fase 2 (Bug 3): recuperación de agencia. `agencyStale` cubre
              // datos vigentes sin POST (restauración/entrada); `agencyMismatch`
              // cubre el 404 CHECKOUT_AGENCY_NOT_ASSIGNED del backend. El
              // wrapper `lock.attempt_id` de arriba ya excluye intentos
              // existentes/terminales (`!attemptId` lo deja explícito). NO se
              // toca LockState: asientos, pasajeros y agencia persistida se
              // conservan hasta que el usuario confirme con un refetch
              // exitoso o elige otra agencia en el selector de ESTA pantalla
              // (nunca se deriva a /trips/[id]).
              <div className="mt-5" role="alert">
                <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
                  <p className="text-sm font-semibold text-[#92400e]">
                    La agencia que elegiste ya no ofrece este viaje.
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    Tus asientos y tus pasajeros siguen guardados. Actualiza
                    las ofertas, o elige una agencia disponible en la sección
                    «Elige la agencia» de esta página.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRefreshOffers()}
                  disabled={refreshingOffers}
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {refreshingOffers ? (
                    <LoaderCircle
                      size={16}
                      strokeWidth={1.75}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {refreshingOffers ? 'Actualizando…' : 'Actualizar ofertas'}
                </button>
              </div>
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
                  {creating ? 'Iniciando tu compra…' : 'Reintentar'}
                </button>
              </div>
            ) : lock.seats.length === 0 ? (
              <p className="mt-5 text-sm text-brand-muted">
                Selecciona al menos un asiento para continuar con el pago.
              </p>
            ) : (
              <>
                {agencyWithoutChannels ? (
                  // MKT-007.4 + MKT-008: la agencia no tiene métodos de pago
                  // activos. Se muestran el aviso y los contactos públicos
                  // (o el teléfono legado), pero el checkout CONTINÚA: el
                  // pago se coordina directamente con la agencia y el
                  // comprobante se sube igual por Marketplace, quedando
                  // pendiente de revisión. Sin CTA la compra moría aquí.
                  <div className="mt-5 rounded-[10px] bg-[#fffbeb] px-4 py-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        size={18}
                        strokeWidth={1.75}
                        className="mt-0.5 shrink-0 text-[#92400e]"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-semibold text-[#92400e]">
                          Esta agencia aún no tiene un método de pago configurado
                        </p>
                        {offerContacts.length > 0 ? (
                          <>
                            <p className="mt-1 text-xs text-brand-muted">
                              Puedes contactar a la agencia para recibir ayuda
                              con tu pago. Enviar el comprobante únicamente por
                              WhatsApp no confirma tu reserva. Coordina el pago
                              con ellos y súbelo aquí: quedará pendiente de
                              revisión.
                            </p>
                            <AgencyContactLinks
                              contacts={offerContacts}
                              className="mt-3"
                            />
                          </>
                        ) : selectedOffer?.phone ? (
                          <>
                            <p className="mt-1 text-xs text-brand-muted">
                              Puedes contactar a la agencia para recibir ayuda
                              con tu pago. Enviar el comprobante únicamente por
                              WhatsApp no confirma tu reserva. Coordina el pago
                              con ellos y súbelo aquí: quedará pendiente de
                              revisión.
                            </p>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {offerWhatsApp ? (
                                <a
                                  href={offerWhatsApp}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-2 rounded-[10px] bg-[#10b981] px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#059669]"
                                >
                                  <MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" />
                                  Contactar por WhatsApp
                                </a>
                              ) : (
                                <p className="text-xs text-brand-muted">
                                  No pudimos abrir WhatsApp con este número. Cópialo
                                  y contáctalos manualmente.
                                </p>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  void copyToClipboard(selectedOffer.phone!).then((ok) => {
                                    if (ok) toast.success('Copiado al portapapeles');
                                    else toast.error('No se pudo copiar el teléfono');
                                  });
                                }}
                                className="inline-flex items-center gap-2 rounded-[10px] bg-white border border-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#f1f5f9]"
                              >
                                Copiar teléfono: {selectedOffer.phone}
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="mt-1 text-xs text-brand-muted">
                            Tampoco ha publicado un medio de contacto disponible
                            en este momento. Coordina el pago directamente con
                            la agencia cuando puedas y sube tu comprobante aquí:
                            quedará pendiente de revisión.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-brand-muted">
                    {agencyWithoutChannels
                      ? 'Coordina el pago con la agencia y continúa para subir tu comprobante de pago.'
                      : 'Revisa los datos de los pasajeros y continúa para enviar tu comprobante de pago.'}
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
                    {creating ? 'Iniciando tu compra…' : 'Continuar al pago'}
                  </button>
                </div>
              </>
            )}
          </section>

          {attemptId ? (
            <section
              aria-label="Comprobante"
              className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Comprobante de pago
                </h2>
                <span
                  className={
                    verifiedAt
                      ? 'rounded-full bg-[#ecfdf5] px-3 py-1 text-[11px] font-semibold text-[#059669]'
                      : awaitingReview
                        ? 'rounded-full bg-[#fffbeb] px-3 py-1 text-[11px] font-semibold text-[#92400e]'
                        : checkoutRejected
                          ? 'rounded-full bg-[#fef2f2] px-3 py-1 text-[11px] font-semibold text-[#ef4444]'
                          : 'rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted'
                  }
                >
                  {verifiedAt
                    ? 'Pago aprobado'
                    : awaitingReview
                      ? 'Pendiente de revisión'
                      : checkoutRejected
                        ? 'Rechazado'
                        : 'Pago pendiente'}
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
                    {formatDateTimeShort(trip.departure_time)}
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
              </dl>

              <p className="mt-5 text-[12px] font-medium uppercase text-brand-muted">
                Pasajeros
              </p>
              <ul className="mt-2 space-y-2">
                {[...passengers]
                  .sort((a, b) =>
                    compareSeatCodes(
                      seatCodeFor(a.seat_id),
                      seatCodeFor(b.seat_id),
                    ),
                  )
                  .map((passenger) => (
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

              <div className="mt-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
                <span className="text-sm font-semibold text-brand-navy">
                  Importe
                </span>
                <span className="text-[17px] font-extrabold leading-tight text-brand-navy sm:leading-none">
                  {totalCents !== null
                    ? `${formatSeatPrice(totalCents)} por ${passengers.length} asientos`
                    : 'Precio no disponible'}
                </span>
              </div>

              {/* MKT-007.4: canal de pago elegido ANTES del comprobante.
                  MKT-008: sin canales activos notifica coordinatedPayment y
                  el uploader se habilita sin selección. */}
              <PaymentMethodSection
                attemptId={attemptId}
                onSelectionChange={setSelectedMethodId}
                onNoMethodsChange={setCoordinatedPayment}
              />

              {verifiedAt ? (
                // MKT-007 §7: el cierre aprobado no se repite aquí; el
                // bloque «Tu pago fue aprobado» vive en la cabecera.
                null
              ) : awaitingReview ? (
                // Vista de solo lectura: mientras la agencia no decida no se
                // admite otro comprobante y jamás se pinta como pagada.
                <div className="mt-5 rounded-[10px] bg-[#fffbeb] px-4 py-4">
                  <p className="text-sm font-semibold text-[#92400e]">
                    Comprobante enviado. Tu pago está pendiente de revisión.
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    Recibimos el comprobante y la agencia lo está revisando.
                    Te avisaremos cuando sea confirmado.
                  </p>
                  {checkoutMarker?.submitted_at ? (
                    <p className="mt-2 text-xs text-brand-muted">
                      Enviado el{' '}
                      {formatDateTimeShort(checkoutMarker.submitted_at)}
                    </p>
                  ) : null}
                </div>
              ) : checkoutFinal ? (
                // M-1: rejected_final es terminal (fuente: estado crudo de
                // getAttempt). Este bloque va ANTES de la rama de rechazo y
                // de la rama de creación: prevalece sobre
                // remaining_submissions (la ventana puede vencer con
                // proof_count < 3), selectedMethodId y coordinatedPayment.
                // El backend sigue siendo la autoridad en el submit.
                <p className="mt-5 text-sm text-brand-muted">
                  Se agotaron los reenvíos de comprobante para esta compra.
                  Cancela la compra para elegir otros asientos.
                </p>
              ) : checkoutRejected ? (
                <div className="mt-5">
                  <div className="rounded-[10px] bg-[#fef2f2] px-4 py-4">
                    <p className="text-sm font-semibold text-[#ef4444]">
                      Comprobante rechazado
                    </p>
                    {/* MKT-007.1: sin motivo de rechazo ni contador de
                        reenvíos (reglas de copy del ticket). */}
                  </div>
                  {(checkoutMarker?.remaining_submissions ?? 0) > 0 ? (
                    selectedMethodId || coordinatedPayment ? (
                      <ProofUploader
                        attemptId={attemptId}
                        remainingSubmissions={
                          checkoutMarker?.remaining_submissions ?? 1
                        }
                        onSubmitted={handleProofSubmitted}
                        onAlreadySubmitted={handleAlreadySubmitted}
                        secondaryAction={cancelCompraButton}
                      />
                    ) : (
                      // MKT-007.4: sin canal elegido no hay datos de pago
                      // hacia donde guiar al cliente.
                      <p className="mt-4 text-sm text-brand-muted">
                        Selecciona un método de pago para continuar con tu
                        comprobante.
                      </p>
                    )
                  ) : (
                    <p className="mt-4 text-sm text-brand-muted">
                      Se agotaron los reenvíos de comprobante para esta compra.
                      Cancela la compra para elegir otros asientos.
                    </p>
                  )}
                </div>
              ) : selectedMethodId || coordinatedPayment ? (
                <ProofUploader
                  attemptId={attemptId}
                  remainingSubmissions={
                    checkoutMarker?.remaining_submissions ?? 3
                  }
                  onSubmitted={handleProofSubmitted}
                  onAlreadySubmitted={handleAlreadySubmitted}
                  secondaryAction={cancelCompraButton}
                />
              ) : (
                <p className="mt-5 text-sm text-brand-muted">
                  Selecciona un método de pago para continuar con tu comprobante.
                </p>
              )}

              {!verifiedAt && !awaitingReview && !proofVisible ? (
                <div className="mt-4">{cancelCompraButton}</div>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-24">
          {/* Checklist de progreso (solo UI): refleja el estado actual del
              wizard sin alterar su lógica. */}
          <section
            aria-label="Tu progreso"
            className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
              Tu progreso
            </h2>
            <ol className="mt-4 space-y-3">
              {progressoPasos.map((paso) => (
                <li key={paso.label} className="flex items-center gap-3 text-sm">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      paso.done
                        ? 'bg-[#ecfdf5] text-[#176B62]'
                        : 'bg-[#F5F1EC] text-brand-muted'
                    }`}
                  >
                    {paso.done ? (
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key="done"
                          initial={{ scale: 0.3, opacity: 0, rotate: -90 }}
                          animate={{ scale: 1, opacity: 1, rotate: 0 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                          className="inline-flex"
                        >
                          <Check size={14} strokeWidth={2} aria-hidden="true" />
                        </motion.span>
                      </AnimatePresence>
                    ) : (
                      <Circle size={14} strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </span>
                  <span
                    className={
                      paso.done
                        ? 'font-medium text-brand-navy'
                        : 'text-brand-muted'
                    }
                  >
                    {paso.label}
                  </span>
                </li>
              ))}
            </ol>
          </section>

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
                {[...passengers]
                  .sort((a, b) =>
                    compareSeatCodes(
                      seatCodeFor(a.seat_id),
                      seatCodeFor(b.seat_id),
                    ),
                  )
                  .map((passenger) => (
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

            <div className="mt-4 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-brand-muted">Precio por asiento</span>
                {trip.seat_price === null ? (
                  <span className="text-sm font-semibold text-brand-muted">
                    {TRIP_PRICE_PENDING_LABEL}
                  </span>
                ) : (
                  <span className="text-sm font-semibold text-brand-navy">
                    {formatSeatPrice(trip.seat_price)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-black/[0.06] pt-3">
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
              {priceMissing ? (
                <p className="mt-2 text-right text-xs text-brand-muted">
                  Este viaje aún no tiene un precio publicado.
                </p>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p className="flex items-center gap-2 text-sm font-semibold text-brand-navy">
              <ShieldCheck
                size={16}
                strokeWidth={1.75}
                className="text-[#176B62]"
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

      <ConfirmModal
        open={confirmCancel}
        title="¿Cancelar esta compra?"
        description="Se liberarán tus asientos y se borrará la selección y los datos de los pasajeros de esta pantalla. No podrás recuperar esta compra; tendrás que empezar de cero."
        confirmLabel="Sí, cancelar compra"
        cancelLabel="Seguir con la compra"
        loading={cancelling}
        destructive
        onConfirm={() => void handleCancelAttempt()}
        onCancel={() => setConfirmCancel(false)}
      />
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
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-24 sm:px-6">
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
