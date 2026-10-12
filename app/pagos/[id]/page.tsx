"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  CreditCard,
  Eye,
  FileText,
  Loader2,
  Lock,
  Mail,
  Phone,
  RefreshCw,
  User,
  X,
  XCircle,
} from "lucide-react";
import {
  agencyPaymentApi,
  type AgencyPaymentDetail,
} from "@/lib/api";
import { ApiError, getApiErrorMessage } from "@/lib/errors/api-error";
import { formatSeatPrice } from "@/lib/price";
import { formatDateTimeShort } from "@/lib/timezone";

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending: { label: "Pendiente", className: "bg-warning/10 text-warning" },
  verified: { label: "Verificado", className: "bg-success/10 text-success" },
  rejected: { label: "Rechazado", className: "bg-danger/10 text-danger" },
};

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGES[status] ?? {
    label: status,
    className: "bg-brand-mid/10 text-brand-muted",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

function ProofModal({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#e5e7eb] px-6 py-4">
          <h2 className="text-lg font-bold text-brand-navy">Comprobante de pago</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-brand-muted transition-colors hover:bg-[#f1f5f9] hover:text-brand-navy"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-auto p-6">
          <img
            src={url}
            alt="Comprobante de pago"
            className="mx-auto max-h-[70vh] rounded-lg object-contain"
          />
        </div>
      </div>
    </div>
  );
}

function RejectModal({
  open,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold text-brand-navy">Rechazar pago</h2>
        <p className="mt-1 text-sm text-brand-muted">
          Este acción cancelará la reserva y liberará los asientos. El cliente
          deberá enviar un nuevo comprobante.
        </p>
        <label className="mt-4 block text-xs font-medium uppercase text-brand-muted">
          Motivo del rechazo (obligatorio)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej: El monto no coincide con el total de la reserva"
          rows={3}
          maxLength={500}
          className="mt-1.5 w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
        />
        <p className="mt-1 text-right text-xs text-brand-muted">
          {reason.length}/500
        </p>
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-[10px] bg-[#f1f5f9] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e2e8f0] disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={loading || reason.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-[10px] bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Rechazando…
              </>
            ) : (
              "Rechazar pago"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifyModal({
  open,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold text-brand-navy">Verificar pago</h2>
        <p className="mt-1 text-sm text-brand-muted">
          Confirmas que el comprobante es válido y que el pago corresponde al
          monto exacto de la reserva. Esta acción es definitiva.
        </p>
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-[10px] bg-[#f1f5f9] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e2e8f0] disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-blue disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verificando…
              </>
            ) : (
              "Sí, verificar pago"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PagoDetallePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const paymentId = params.id;

  const [detail, setDetail] = useState<AgencyPaymentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await agencyPaymentApi.detail(paymentId);
      setDetail(result);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setError("Este pago no existe o no pertenece a tu agencia.");
      } else {
        setError(getApiErrorMessage(e, "No pudimos cargar el pago. Intenta de nuevo."));
      }
    } finally {
      setLoading(false);
    }
  }, [paymentId]);

  useEffect(() => {
    load();
  }, [load]);

  const openProof = async () => {
    if (!detail?.payment.has_proof) return;
    setProofLoading(true);
    setProofError(null);
    try {
      const result = await agencyPaymentApi.proofUrl(paymentId);
      setProofUrl(result.url);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PAYMENT_PROOF_NOT_FOUND") {
        setProofError("Este pago no tiene comprobante adjunto.");
      } else {
        setProofError(getApiErrorMessage(e, "No pudimos cargar el comprobante. Intenta de nuevo."));
      }
    } finally {
      setProofLoading(false);
    }
  };

  const closeProof = () => {
    setProofUrl(null);
  };

  const handleVerify = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      const result = await agencyPaymentApi.verify(paymentId);
      toast.success(
        result.already_verified
          ? "Este pago ya había sido verificado."
          : "Pago verificado correctamente.",
      );
      setVerifyOpen(false);
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "No se pudo verificar el pago. Intenta de nuevo."));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (reason: string) => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      const result = await agencyPaymentApi.reject(paymentId, reason);
      toast.success(
        result.already_rejected
          ? "Este pago ya había sido rechazado."
          : "Pago rechazado. La reserva fue cancelada.",
      );
      setRejectOpen(false);
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "No se pudo rechazar el pago. Intenta de nuevo."));
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="flex-1 bg-[var(--color-page-bg)] pt-16">
        <div className="mx-auto max-w-[1600px] px-8 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-8 w-48 rounded bg-brand-mid/10" />
            <div className="h-64 rounded-2xl bg-brand-mid/10" />
          </div>
        </div>
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main className="flex-1 bg-[var(--color-page-bg)] pt-16">
        <div className="mx-auto max-w-[1600px] px-8 py-8">
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#e5e7eb] bg-brand-surface py-16">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-danger/10">
              <AlertTriangle className="h-8 w-8 text-danger" />
            </div>
            <p className="mt-4 text-lg font-semibold text-brand-navy">
              {error ?? "No pudimos cargar el pago"}
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => load()}
                className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-5 py-2.5 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e2e8f0]"
              >
                <RefreshCw className="h-4 w-4" />
                Reintentar
              </button>
              <Link
                href="/pagos"
                className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-blue"
              >
                <ArrowLeft className="h-4 w-4" />
                Volver a pagos
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const { payment, reservation, trip, passengers, allocations, totals } = detail;
  const isPending = payment.status === "pending";

  return (
    <main className="flex-1 bg-[var(--color-page-bg)] pt-16">
      <div className="mx-auto max-w-[1600px] px-8 py-8">
        <Link
          href="/pagos"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-muted transition-colors hover:text-brand-navy"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver a pagos
        </Link>

        <div className="mt-4 border-l-4 border-brand-cyan pl-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] font-extrabold text-brand-navy">
              Detalle del pago
            </h1>
            <StatusBadge status={payment.status} />
          </div>
          <p className="mt-1 text-sm text-brand-muted">
            {trip
              ? `${trip.origin} → ${trip.destination}`
              : "Ruta no disponible"}
            {trip && ` · ${formatDateTimeShort(trip.departure_time)}`}
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                Resumen del pago
              </h2>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs font-medium uppercase text-brand-muted">
                    Monto
                  </p>
                  <p className="mt-0.5 text-xl font-bold text-brand-navy">
                    {formatSeatPrice(payment.amount_cents)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-brand-muted">
                    Enviado
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-brand-navy">
                    {formatDateTimeShort(payment.submitted_at)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-brand-muted">
                    Reserva
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-brand-navy">
                    {reservation.status}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-brand-muted">
                    Pasajeros activos
                  </p>
                  <p className="mt-0.5 text-xl font-bold text-brand-navy">
                    {totals.active_passenger_count}
                  </p>
                </div>
              </div>

              {payment.status === "rejected" && payment.rejection_reason && (
                <div className="mt-4 rounded-lg bg-danger/5 px-4 py-3">
                  <p className="text-xs font-medium uppercase text-danger">
                    Motivo del rechazo
                  </p>
                  <p className="mt-1 text-sm text-brand-navy">
                    {payment.rejection_reason}
                  </p>
                </div>
              )}

              {payment.status === "verified" && payment.verified_at && (
                <div className="mt-4 rounded-lg bg-success/5 px-4 py-3">
                  <p className="text-xs font-medium uppercase text-success">
                    Verificado
                  </p>
                  <p className="mt-1 text-sm text-brand-navy">
                    {formatDateTimeShort(payment.verified_at)}
                  </p>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                Pasajeros
              </h2>
              <ul className="mt-4 divide-y divide-[#e5e7eb]">
                {passengers.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-mid/10">
                        <User className="h-4 w-4 text-brand-muted" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-brand-navy">
                          {p.name}
                        </p>
                        <p className="text-xs text-brand-muted">
                          Asiento {p.seat_code ?? "—"} · {p.status}
                        </p>
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-brand-navy">
                      {p.unit_price != null ? formatSeatPrice(p.unit_price) : "—"}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            {allocations.length > 0 && (
              <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                  Asignaciones del pago
                </h2>
                <ul className="mt-4 divide-y divide-[#e5e7eb]">
                  {allocations.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-semibold text-brand-navy">
                          Asiento {a.seat_code ?? "—"}
                        </p>
                        <p className="text-xs text-brand-muted">
                          {formatDateTimeShort(a.created_at)}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-brand-navy">
                        {formatSeatPrice(a.amount_cents)}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div className="space-y-6">
            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                Booker
              </h2>
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-brand-muted" />
                  <span className="text-sm font-semibold text-brand-navy">
                    {reservation.booker_name || "—"}
                  </span>
                </div>
                {reservation.booker_phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-brand-muted" />
                    <span className="text-sm text-brand-navy">
                      {reservation.booker_phone}
                    </span>
                  </div>
                )}
                {reservation.contact_email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-brand-muted" />
                    <span className="text-sm text-brand-navy">
                      {reservation.contact_email}
                    </span>
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                Comprobante
              </h2>
              {payment.has_proof ? (
                <button
                  type="button"
                  onClick={openProof}
                  disabled={proofLoading}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e2e8f0] disabled:opacity-40"
                >
                  {proofLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Cargando…
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4" />
                      Ver comprobante
                    </>
                  )}
                </button>
              ) : (
                <p className="mt-4 text-sm text-brand-muted">
                  Este pago no tiene comprobante adjunto.
                </p>
              )}
              {proofError && (
                <p className="mt-2 text-xs text-danger">{proofError}</p>
              )}
            </section>

            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                Totales
              </h2>
              <div className="mt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-brand-muted">Esperado</span>
                  <span className="font-semibold text-brand-navy">
                    {formatSeatPrice(totals.expected_cents)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-brand-muted">Asignado</span>
                  <span className="font-semibold text-brand-navy">
                    {formatSeatPrice(totals.allocated_cents)}
                  </span>
                </div>
                <div className="flex justify-between text-sm border-t border-[#e5e7eb] pt-2">
                  <span className="text-brand-muted">Diferencia</span>
                  <span
                    className={`font-semibold ${
                      totals.remaining_cents === 0
                        ? "text-success"
                        : "text-warning"
                    }`}
                  >
                    {formatSeatPrice(totals.remaining_cents)}
                  </span>
                </div>
              </div>
            </section>

            {isPending && (
              <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-lg font-bold text-brand-navy">
                  Acciones
                </h2>
                <div className="mt-4 space-y-3">
                  <button
                    type="button"
                    onClick={() => setVerifyOpen(true)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Verificar pago
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejectOpen(true)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#fef2f2] px-4 py-3 text-sm font-semibold text-danger transition-colors duration-200 hover:bg-[#fee2e2]"
                  >
                    <XCircle className="h-4 w-4" />
                    Rechazar pago
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {proofUrl && <ProofModal url={proofUrl} onClose={closeProof} />}

      <VerifyModal
        open={verifyOpen}
        onConfirm={handleVerify}
        onCancel={() => setVerifyOpen(false)}
        loading={actionLoading}
      />

      <RejectModal
        open={rejectOpen}
        onConfirm={handleReject}
        onCancel={() => setRejectOpen(false)}
        loading={actionLoading}
      />
    </main>
  );
}
