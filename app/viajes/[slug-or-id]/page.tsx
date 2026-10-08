"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  publicApi,
  seatApi,
  type ClaimGuestLocksResult,
  type PublicTripDetail,
  type PublicTripOffer,
} from "@/lib/api";
import { ApiError, getApiErrorMessage } from "@/lib/errors/api-error";
import { formatDateTimeShort, formatTime12h } from "@/lib/timezone";
import { formatSeatPrice } from "@/lib/price";
import { readLockState, writeLockState } from "@/lib/booking/lock-state";
import {
  claimPendingGuestLocks,
  type GuestClaimResult,
} from "@/lib/booking/guest-claim";
import { applySeatRow, removeSeatRow } from "@/lib/booking/seat-map";
import { useSeatLocking } from "@/lib/booking/useSeatLocking";
import type {
  RealtimeSeatRow,
  SeatEventType,
} from "@/lib/realtime/subscriptions";
import { useOptionalAuthUser } from "@/components/auth/AuthProvider";
import { LockCountdown } from "@/components/booking/LockCountdown";
import { BusLayout } from "@/components/bus/BusLayout";

interface TripDetailPageProps {
  params: Promise<{ "slug-or-id": string }>;
}

function vehicleLabel(vehicleType: string): string {
  if (vehicleType === "bus") return "Autobús";
  if (vehicleType === "kia") return "Kia";
  return vehicleType;
}

/**
 * Asiento bloqueado por el cliente actual. El lock ocurre en el click, así que
 * el estado local conserva los valores reales devueltos por el servidor
 * (`lock_expires_at`, `locked_by`) y no solo el código del asiento.
 *
 * `owner` refleja QUÉ endpoint creó el lock (guest → cookie HttpOnly,
 * customer → `locked_by`): decide con qué API se libera. Es un reflejo de lo
 * que el servidor ya confirmó, nunca una autoridad paralela.
 */
interface HeldSeat {
  id: string;
  seat_code: string;
  status: "locked";
  locked_by: string | null;
  lock_expires_at: string;
  owner: "guest" | "customer";
}

function parseExpiry(expiresAt: string): number | null {
  const timestamp = Date.parse(expiresAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/** El countdown siempre deriva de la expiración MÁS PRÓXIMA entre los locks. */
function earliestExpiry(seats: HeldSeat[]): string | null {
  let earliest: number | null = null;
  for (const seat of seats) {
    const expires = parseExpiry(seat.lock_expires_at);
    if (expires === null) continue;
    if (earliest === null || expires < earliest) earliest = expires;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/**
 * Recupera los locks vigentes que el usuario ya había confirmado (se escriben
 * al pulsar "Continuar"). Solo se aceptan asientos que el servidor sigue
 * marcando como `locked`, así un lock vencido o liberado no reaparece.
 * Aplica al customer autenticado; el guest se restaura desde la cookie vía
 * `GET /guest-locks` (la autoridad es el servidor, no el storage local).
 */
function restoreHeldSeats(trip: PublicTripDetail): HeldSeat[] {
  const stored = readLockState();
  if (!stored || stored.trip_id !== trip.id) return [];
  const storedExpiry = parseExpiry(stored.lock_expires_at);
  if (storedExpiry === null || storedExpiry <= Date.now()) return [];

  const byId = new Map(trip.seats.map((seat) => [seat.id, seat]));
  return stored.seats.flatMap(({ id }) => {
    const seat = byId.get(id);
    if (!seat || seat.status !== "locked") return [];
    return [
      {
        id: seat.id,
        seat_code: seat.seat_code,
        status: "locked" as const,
        locked_by: null,
        lock_expires_at: stored.lock_expires_at,
        owner: "customer" as const,
      },
    ];
  });
}

/** Locks guest devueltos por el servidor → estado local (solo si existen). */
function toHeldSeats(
  trip: PublicTripDetail,
  seats: Array<{ id: string; seat_code: string; lock_expires_at: string }>,
): HeldSeat[] {
  const byId = new Map(trip.seats.map((seat) => [seat.id, seat]));
  return seats.flatMap((item) => {
    const seat = byId.get(item.id);
    if (!seat || seat.status !== "locked") return [];
    return [
      {
        id: seat.id,
        seat_code: seat.seat_code,
        status: "locked" as const,
        locked_by: null,
        lock_expires_at: item.lock_expires_at,
        owner: "guest" as const,
      },
    ];
  });
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase text-brand-muted">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-brand-navy">{value}</dd>
    </div>
  );
}

function OfferCard({
  offer,
  checked,
  onSelect,
}: {
  offer: PublicTripOffer;
  checked: boolean;
  onSelect: () => void;
}) {
  const accent = offer.accent_color ?? "#00D4FF";
  const primary = offer.primary_color ?? "#000024";
  const initial = offer.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex items-center gap-3 rounded-2xl border-[1.5px] bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5"
      style={{
        borderColor: checked ? accent : "#e5e7eb",
        boxShadow: checked
          ? "0 6px 24px rgba(0,0,0,0.08)"
          : "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      {offer.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={offer.logo_url}
          alt={`Logo de ${offer.name}`}
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
          style={{ background: primary }}
          aria-hidden="true"
        >
          {initial}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-brand-navy">
          {offer.name}
        </span>
        <span className="block text-xs text-brand-muted">Oferta disponible</span>
      </span>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{
          background: checked ? accent : "#f1f5f9",
        }}
        aria-hidden="true"
      >
        {checked && (
          <Check
            size={14}
            strokeWidth={2.5}
            className="text-white"
            aria-hidden="true"
          />
        )}
      </span>
    </button>
  );
}

export default function TripDetailPage({ params }: TripDetailPageProps) {
  const { "slug-or-id": slug } = use(params);
  const router = useRouter();

  const auth = useOptionalAuthUser();
  const userId = auth?.user?.id ?? null;

  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  // Asientos que YO tengo bloqueados ahora mismo (lock confirmado por el
  // servidor). De aquí se derivan la selección visual, el countdown y los ids
  // que se envían al wizard.
  const [heldSeats, setHeldSeats] = useState<HeldSeat[]>([]);
  // Operaciones de lock/unlock en curso, por asiento: permite varios clicks
  // simultáneos sin bloquear toda la selección.
  const [pendingCount, setPendingCount] = useState(0);

  const heldRef = useRef<HeldSeat[]>([]);
  heldRef.current = heldSeats;
  const pendingRef = useRef<Set<string>>(new Set());
  const tripId = trip?.id ?? null;
  const tripIdRef = useRef<string | null>(null);
  tripIdRef.current = tripId;
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;
  // `Continuar` conserva los locks al navegar; el resto de desmontajes los libera.
  const retainLocksRef = useRef(false);
  const unlockSentRef = useRef(false);
  const restoreDoneRef = useRef(false);
  const restoredRef = useRef(false);
  const claimStartedRef = useRef(false);
  const tripEndedHandledRef = useRef(false);

  const selectedSeats = useMemo(
    () => heldSeats.map((seat) => seat.seat_code),
    [heldSeats],
  );
  const mySeatIds = useMemo(
    () => heldSeats.map((seat) => seat.id),
    [heldSeats],
  );
  const lockExpiresAt = useMemo(() => earliestExpiry(heldSeats), [heldSeats]);
  const locking = pendingCount > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const response = await publicApi.tripDetail(slug);
      setTrip(response.trip);
      setSelectedOffer(response.trip.offers[0]?.agency_id ?? null);
      // Recargas posteriores (viaje cancelado/completado) nunca restauran:
      // la primera restauración la resuelve el efecto según la identidad.
      if (restoreDoneRef.current) setHeldSeats([]);
      restoreDoneRef.current = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            "No pudimos cargar el viaje. Intenta de nuevo.",
          ),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshSeats = useCallback(async () => {
    const refreshed = await publicApi.tripDetail(slug).catch(() => null);
    if (!refreshed) return;
    // Solo refresca el mapa: la pertenencia de un lock propio nunca se deduce
    // de la respuesta pública (no incluye `locked_by`). Las pérdidas reales
    // llegan por realtime vía `onSeatLost`.
    setTrip(refreshed.trip);
  }, [slug]);

  // ─── Restauración de locks al cargar ────────────────────────────────
  // Customer: valida su selección guardada contra el servidor (flujo MKT-004).
  // Guest: la fuente de verdad es la cookie HttpOnly vía GET /guest-locks;
  // el storage local nunca decide la propiedad de un lock guest.
  useEffect(() => {
    if (!trip || restoredRef.current) return;
    if (auth?.loading) return;
    restoredRef.current = true;

    if (userId) {
      setHeldSeats(restoreHeldSeats(trip));
      return;
    }

    const guestTrip = trip;
    setHeldSeats([]);
    void seatApi
      .getGuestLocks(guestTrip.id)
      .then((locks) => {
        const restored = toHeldSeats(guestTrip, locks.seats);
        if (restored.length === 0) return;
        setHeldSeats((prev) => {
          const restoredIds = new Set(restored.map((seat) => seat.id));
          return [
            ...restored,
            ...prev.filter((item) => !restoredIds.has(item.id)),
          ];
        });
      })
      .catch(() => {
        // Sin cookie o sesión guest resuelta: no hay nada que restaurar.
      });
  }, [trip, auth, userId]);

  // ─── Claim automático guest → customer ──────────────────────────────

  /** ownership real desde el servidor cuando el claim no pudo transferir. */
  const syncCustomerLocks = useCallback(async () => {
    const tripId = tripIdRef.current;
    if (!tripId) return;
    const locks = await seatApi.mySeatLocks(tripId).catch(() => null);
    if (!locks) return;
    setHeldSeats(
      locks.seats.map((seat) => ({
        id: seat.id,
        seat_code: seat.seat_code,
        status: "locked" as const,
        locked_by: userIdRef.current,
        lock_expires_at: seat.lock_expires_at,
        owner: "customer" as const,
      })),
    );
    void refreshSeats();
  }, [refreshSeats]);

  /**
   * Claim exitoso: el backend devuelve los MISMOS seats con la misma
   * expiración (nunca se reinicia el TTL), solo cambia el ownership.
   */
  const adoptClaimedSeats = useCallback((claim: ClaimGuestLocksResult) => {
    const claimed: HeldSeat[] = claim.seats.map((seat) => ({
      id: seat.id,
      seat_code: seat.seat_code,
      status: "locked" as const,
      locked_by: userIdRef.current,
      lock_expires_at: seat.lock_expires_at,
      owner: "customer" as const,
    }));
    setHeldSeats((prev) => {
      const claimedIds = new Set(claimed.map((seat) => seat.id));
      return [...prev.filter((item) => !claimedIds.has(item.id)), ...claimed];
    });
  }, []);

  const handleClaimResult = useCallback(
    async (result: GuestClaimResult) => {
      if (result.outcome === "no-pending") return;

      switch (result.outcome) {
        case "claimed":
          if (result.claim) adoptClaimedSeats(result.claim);
          toast.success("Tus asientos siguen bloqueados con tu cuenta");
          break;
        case "already-claimed":
          // Otra pestaña ya lo reclamó: el ownership real manda.
          await syncCustomerLocks();
          toast.success("Tus asientos siguen bloqueados con tu cuenta");
          break;
        case "expired":
          setHeldSeats((prev) =>
            prev.filter((seat) => seat.owner !== "guest"),
          );
          toast.error("Tu selección expiró. Elige tus asientos de nuevo.");
          void refreshSeats();
          break;
        case "empty":
          await syncCustomerLocks();
          toast.error(
            "Tu selección ya no está disponible. Elige tus asientos de nuevo.",
          );
          break;
        case "conflict":
          await syncCustomerLocks();
          toast.error(
            getApiErrorMessage(
              result.error,
              "No pudimos conservar tus asientos. Revisa tu selección.",
            ),
          );
          break;
        default:
          toast.error(
            getApiErrorMessage(
              result.error,
              "No pudimos reclamar tus asientos. Intenta de nuevo.",
            ),
          );
      }
    },
    [adoptClaimedSeats, refreshSeats, syncCustomerLocks],
  );

  // Solo UN claim por transición guest → authenticated, nunca por render.
  useEffect(() => {
    if (!tripId || !userId || auth?.loading) return;
    if (claimStartedRef.current) return;
    claimStartedRef.current = true;
    void claimPendingGuestLocks(tripId).then(handleClaimResult);
  }, [auth, handleClaimResult, tripId, userId]);

  const beginPending = useCallback((seatId: string) => {
    pendingRef.current.add(seatId);
    setPendingCount(pendingRef.current.size);
  }, []);

  const endPending = useCallback((seatId: string) => {
    pendingRef.current.delete(seatId);
    setPendingCount(pendingRef.current.size);
  }, []);

  const handleLockError = useCallback(
    (e: unknown, options: { guest?: boolean; seatId?: string } = {}) => {
      const { guest = false, seatId } = options;
      if (e instanceof ApiError && e.status === 401) {
        if (guest) {
          // La sesión guest venció o ya no existe: el servidor no la reconoce,
          // así que el asiento deja de ser nuestro de inmediato.
          if (seatId) {
            setHeldSeats((prev) =>
              prev.filter((item) => item.id !== seatId),
            );
          }
          toast.error("Tu selección expiró. Elige tus asientos de nuevo.");
          void refreshSeats();
          return;
        }
        toast.error("Inicia sesión para continuar con tu reserva");
        retainLocksRef.current = false;
        router.push(`/login?redirect=${encodeURIComponent(`/viajes/${slug}`)}`);
      } else if (e instanceof ApiError && e.status === 409) {
        toast.error(
          getApiErrorMessage(e, "Ese asiento ya no está disponible."),
        );
        void refreshSeats();
      } else {
        toast.error(
          getApiErrorMessage(
            e,
            "No pudimos actualizar el asiento. Intenta de nuevo.",
          ),
        );
      }
    },
    [refreshSeats, router, slug],
  );

  /**
   * Click en un asiento → lock/unlock INMEDIATO (patrón de `nomadas-tour`).
   * El usuario permanece en el mapa y puede acumular varios locks.
   * Customer → `/lock` y `/unlock`; guest → `/lock-guest` y `/unlock-guest`
   * con la cookie HttpOnly. Nunca se usan los dos sistemas a la vez.
   */
  const toggleSeat = useCallback(
    async (seatCode: string) => {
      if (!trip) return;
      const seat = trip.seats.find((item) => item.seat_code === seatCode);
      if (!seat) return;
      if (pendingRef.current.has(seat.id)) return;

      const held = heldRef.current.find((item) => item.id === seat.id);
      const mine = Boolean(held);

      if (!mine && seat.status !== "available") return;

      const asGuest = held
        ? held.owner === "guest"
        : userIdRef.current === null;

      beginPending(seat.id);
      try {
        if (mine) {
          if (asGuest) {
            await seatApi.unlockGuestSeats(trip.id, [seat.id]);
          } else {
            await seatApi.unlockSeats(trip.id, [seat.id]);
          }
          setHeldSeats((prev) => prev.filter((item) => item.id !== seat.id));
          setTrip((prev) =>
            prev ? applySeatRow(prev, { ...seat, status: "available" }) : prev,
          );
          toast.success(`Asiento ${seatCode} liberado`);
        } else {
          const result = asGuest
            ? await seatApi.lockGuestSeats(trip.id, [seat.id])
            : await seatApi.lockSeats(trip.id, [seat.id]);
          unlockSentRef.current = false;
          setHeldSeats((prev) => [
            ...prev.filter((item) => item.id !== seat.id),
            {
              id: seat.id,
              seat_code: seat.seat_code,
              status: "locked",
              locked_by: asGuest
                ? null
                : (result.seats[0]?.locked_by ?? userIdRef.current ?? null),
              lock_expires_at: result.lock_expires_at,
              owner: asGuest ? "guest" : "customer",
            },
          ]);
          setTrip((prev) =>
            prev ? applySeatRow(prev, { ...seat, status: "locked" }) : prev,
          );
        }
      } catch (e) {
        handleLockError(e, { guest: asGuest, seatId: seat.id });
      } finally {
        endPending(seat.id);
      }
    },
    [beginPending, endPending, handleLockError, trip],
  );

  // ─── Realtime (estilo nomadas-tour) ─────────────────────────────────

  const handleSeatEvent = useCallback(
    (seat: RealtimeSeatRow, eventType: SeatEventType) => {
      setTrip((prev) => {
        if (!prev) return prev;
        return eventType === "DELETE"
          ? removeSeatRow(prev, seat.id)
          : applySeatRow(prev, seat);
      });
    },
    [],
  );

  // Un lock propio dejó de ser mío: venció, lo liberé o alguien lo tomó.
  const handleSeatLost = useCallback((seat: RealtimeSeatRow) => {
    if (pendingRef.current.has(seat.id)) return;
    setHeldSeats((prev) => prev.filter((item) => item.id !== seat.id));
    toast.error(`El asiento ${seat.seat_code} ya no está disponible`);
  }, []);

  const handleTripCancelled = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error("Este viaje fue cancelado. Elige otro viaje disponible.");
    void load();
  }, [load]);

  const handleTripCompleted = useCallback(() => {
    if (tripEndedHandledRef.current) return;
    tripEndedHandledRef.current = true;
    toast.error("Este viaje ya fue completado. Elige otro viaje disponible.");
    void load();
  }, [load]);

  useSeatLocking({
    tripId: trip?.id ?? null,
    mySeatIds,
    userId,
    onSeatEvent: handleSeatEvent,
    onSeatLost: handleSeatLost,
    onTripCancelled: handleTripCancelled,
    onTripCompleted: handleTripCompleted,
    onRefresh: refreshSeats,
  });

  // El countdown llegó a cero: los locks vencidos dejan de ser seleccionables.
  // La liberación definitiva de la BD la hace el backend (cleanup cada 60s).
  const handleLockExpired = useCallback(() => {
    setHeldSeats((prev) =>
      prev.filter((seat) => (parseExpiry(seat.lock_expires_at) ?? 0) > Date.now()),
    );
    void refreshSeats();
  }, [refreshSeats]);

  // Al abandonar la pantalla sin haber ido al wizard, se liberan los locks
  // propios para no dejar asientos huérfanos durante el TTL.
  // Cada lock se libera con EL MISMO sistema que lo creó: guest → cookie
  // HttpOnly (`/unlock-guest`), customer → `/unlock`. Nunca los dos sin más.
  const sendUnlockKeepalive = useCallback(() => {
    if (retainLocksRef.current || unlockSentRef.current) return;
    const activeTripId = tripIdRef.current;
    const held = heldRef.current;
    if (!activeTripId || held.length === 0) return;
    unlockSentRef.current = true;
    if (held.some((seat) => seat.owner === "guest")) {
      void Promise.resolve(
        seatApi.unlockGuestSeats(activeTripId, undefined, { keepalive: true }),
      ).catch(() => undefined);
    }
    if (held.some((seat) => seat.owner === "customer")) {
      void Promise.resolve(
        seatApi.unlockSeats(activeTripId, undefined, { keepalive: true }),
      ).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", sendUnlockKeepalive);
    return () => {
      window.removeEventListener("beforeunload", sendUnlockKeepalive);
      sendUnlockKeepalive();
    };
  }, [sendUnlockKeepalive]);

  /**
   * `Continuar` ya NO bloquea: los locks se hicieron en cada click. Su trabajo
   * es validar la selección, persistir el estado del booking y navegar.
   */
  const continueWithSelection = useCallback(() => {
    if (!trip || locking || heldSeats.length === 0 || !lockExpiresAt) return;

    retainLocksRef.current = true;
    writeLockState({
      trip_id: trip.id,
      agency_id: selectedOffer,
      seats: heldSeats.map(({ id, seat_code }) => ({ id, seat_code })),
      lock_expires_at: lockExpiresAt,
      passengers: [],
    });
    router.push("/reservas/nueva");
  }, [heldSeats, lockExpiresAt, locking, router, selectedOffer, trip]);

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="animate-pulse" aria-hidden="true">
          <div className="h-4 w-44 rounded-full bg-black/[0.06]" />
          <div className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-8">
            <div className="h-5 w-40 rounded-full bg-black/[0.06]" />
            <div className="mt-4 h-8 w-2/3 rounded bg-black/[0.06]" />
            <div className="mt-4 h-4 w-1/3 rounded bg-black/[0.06]" />
          </div>
          <div className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="h-5 w-52 rounded-full bg-black/[0.06]" />
            <div className="mt-6 flex justify-center">
              <div className="h-64 w-full max-w-[280px] rounded-2xl bg-black/[0.06]" />
            </div>
          </div>
        </div>
        <span className="sr-only">Cargando viaje…</span>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold">Viaje no encontrado</h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Este viaje no existe, ya no está activo o el enlace no es válido.
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

  if (error || !trip) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold">
            No pudimos cargar el viaje
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  const soldOut = trip.availability.available === 0;
  const hasPrice = trip.seat_price !== null;
  const offers = trip.offers;
  const canContinue = !soldOut && selectedSeats.length > 0;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
      <Link
        href="/viajes"
        className="inline-flex items-center gap-2 text-sm font-semibold text-brand-muted transition-colors duration-200 hover:text-brand-cyan"
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Volver a los viajes
      </Link>

      <section className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-[#f1f5f9] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
                {vehicleLabel(trip.vehicle_type)} · {trip.capacity} asientos
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                  soldOut
                    ? "bg-[#fef2f2] text-[#ef4444]"
                    : "bg-[#ecfdf5] text-[#059669]"
                }`}
              >
                {soldOut
                  ? "Sin disponibilidad"
                  : `${trip.availability.available} disponibles`}
              </span>
            </div>
            <h1 className="mt-4 text-[28px] font-extrabold leading-tight text-brand-navy">
              {trip.route.origin} → {trip.route.destination}
            </h1>
            <p className="mt-3 flex items-center gap-2 text-sm text-brand-muted">
              <CalendarDays
                size={16}
                strokeWidth={1.75}
                className="shrink-0"
                aria-hidden="true"
              />
              {formatDateTimeShort(trip.departure_time)}
            </p>
          </div>

          <div className="rounded-2xl bg-[#f1f5f9] p-4 sm:min-w-[220px]">
            <p className="text-[11px] font-medium uppercase text-brand-muted">
              Precio por asiento
            </p>
            {hasPrice ? (
              <>
                <p className="mt-1 text-[28px] font-extrabold leading-none text-brand-navy">
                  {formatSeatPrice(trip.seat_price as number)}
                </p>
                {trip.installment_allowed &&
                  trip.installment_amount_cents !== null && (
                    <p className="mt-2 text-xs text-brand-muted">
                      Abono desde{" "}
                      {formatSeatPrice(trip.installment_amount_cents)}
                    </p>
                  )}
              </>
            ) : (
              <p className="mt-2 text-sm font-semibold text-brand-muted">
                Precio no disponible
              </p>
            )}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoItem
            label="Salida"
            value={formatDateTimeShort(trip.departure_time)}
          />
          <InfoItem label="Hora" value={formatTime12h(trip.departure_time)} />
          <InfoItem
            label="Disponibles"
            value={`${trip.availability.available} de ${trip.capacity}`}
          />
          <InfoItem label="Vehículo" value={vehicleLabel(trip.vehicle_type)} />
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
          Elige con quien quieres viajar
        </h2>
        {offers.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-black/[0.06] bg-brand-surface p-4 text-sm text-brand-muted shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            Las agencias de este viaje estarán disponibles pronto. Puedes ver el
            mapa de asientos mientras tanto.
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Ofertas de agencia"
            className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {offers.map((offer) => (
              <OfferCard
                key={offer.agency_id}
                offer={offer}
                checked={selectedOffer === offer.agency_id}
                onSelect={() => setSelectedOffer(offer.agency_id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
            Elige tus asientos
          </h2>
          <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
            {trip.availability.available} de {trip.capacity} disponibles
          </span>
        </div>

        {soldOut && (
          <div
            className="mt-4 flex items-start gap-3 rounded-[10px] bg-[#fef2f2] p-4 text-sm text-[#ef4444]"
            role="alert"
          >
            <AlertTriangle
              size={18}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Este viaje ya no tiene asientos disponibles. Elige otra fecha o
              ruta desde el catálogo.
            </span>
          </div>
        )}

        <div className="mt-6">
          <BusLayout
            vehicleType={trip.vehicle_type}
            seats={trip.seats}
            selectedSeats={selectedSeats}
            onToggleSeat={toggleSeat}
          />
        </div>

        {selectedSeats.length > 0 && (
          <div
            className="mt-6 rounded-[10px] bg-[#fffbeb] p-4 text-sm text-[#92400e]"
            role="status"
          >
            <span className="font-semibold">
              {selectedSeats.length} asiento
              {selectedSeats.length === 1 ? "" : "s"} seleccionado
              {selectedSeats.length === 1 ? "" : "s"}
              :
            </span>{" "}
            {selectedSeats.join(", ")}
          </div>
        )}

        {selectedSeats.length > 0 && lockExpiresAt && (
          <div className="mt-4 flex justify-center">
            <LockCountdown
              expiresAt={lockExpiresAt}
              onExpired={handleLockExpired}
            />
          </div>
        )}

        <p className="mt-4 text-center text-xs text-brand-muted">
          Cada asiento que eliges queda bloqueado al instante durante 15
          minutos. Tócalo de nuevo para liberarlo.
        </p>
      </section>

      <div className="mt-8 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={continueWithSelection}
          disabled={!canContinue || locking}
          aria-disabled={!canContinue || locking}
          className={`w-full rounded-[10px] px-8 py-3.5 text-sm font-semibold text-white transition-colors duration-200 sm:w-auto ${
            canContinue && !locking
              ? "cursor-pointer bg-brand-cyan hover:bg-brand-blue"
              : "cursor-not-allowed bg-brand-cyan opacity-40"
          }`}
        >
          {locking ? (
            <span className="inline-flex items-center justify-center gap-2">
              <LoaderCircle
                size={16}
                strokeWidth={1.75}
                className="animate-spin"
                aria-hidden="true"
              />
              Bloqueando asientos…
            </span>
          ) : soldOut ? (
            "Sin asientos disponibles"
          ) : (
            "Continuar con la reserva"
          )}
        </button>
        <p className="text-xs text-brand-muted">
          {soldOut
            ? "Revisa el catálogo para encontrar otro viaje."
            : userId
              ? "Tus asientos ya están bloqueados por 15 minutos. Continúa para completar tus datos."
              : "Tus asientos quedan bloqueados al instante. Al continuar te pediremos iniciar sesión para conservarlos."}
        </p>
      </div>
    </main>
  );
}
