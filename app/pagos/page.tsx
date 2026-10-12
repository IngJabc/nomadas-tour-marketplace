"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Eye,
  FileText,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  agencyPaymentApi,
  type AgencyPaymentListItem,
  type AgencyPaymentStatusFilter,
} from "@/lib/api";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { formatSeatPrice } from "@/lib/price";
import { formatDateTimeShort } from "@/lib/timezone";

const PAGE_SIZE = 20;

type StatusFilter = AgencyPaymentStatusFilter | "all";

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendientes" },
  { value: "verified", label: "Verificados" },
  { value: "rejected", label: "Rechazados" },
];

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending: {
    label: "Pendiente",
    className: "bg-warning/10 text-warning",
  },
  verified: {
    label: "Verificado",
    className: "bg-success/10 text-success",
  },
  rejected: {
    label: "Rechazado",
    className: "bg-danger/10 text-danger",
  },
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

function PaymentCard({
  payment,
  onView,
}: {
  payment: AgencyPaymentListItem;
  onView: () => void;
}) {
  const trip = payment.reservation.trip;
  const routeLabel = trip
    ? `${trip.origin} → ${trip.destination}`
    : "Ruta no disponible";

  return (
    <article className="group rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_24px_rgba(0,212,255,0.12)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge status={payment.status} />
            {payment.has_proof && (
              <span className="inline-flex items-center gap-1 text-xs text-brand-muted">
                <FileText className="h-3.5 w-3.5" />
                Comprobante
              </span>
            )}
          </div>
          <p className="mt-2 truncate text-sm font-semibold text-brand-navy">
            {payment.reservation.booker_name || "Reserva"}
          </p>
          <p className="mt-0.5 text-sm text-brand-muted">{routeLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-brand-navy">
            {formatSeatPrice(payment.amount_cents)}
          </p>
          <p className="mt-0.5 text-xs text-brand-muted">
            {formatDateTimeShort(payment.submitted_at)}
          </p>
        </div>
      </div>

      {payment.status === "rejected" && payment.rejection_reason && (
        <p className="mt-3 rounded-lg bg-danger/5 px-3 py-2 text-xs text-danger">
          Motivo: {payment.rejection_reason}
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onView}
          className="inline-flex items-center gap-1.5 rounded-[10px] bg-[#f1f5f9] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
        >
          <Eye className="h-4 w-4" />
          Ver detalle
        </button>
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-5 w-20 rounded-full bg-brand-mid/10" />
          <div className="h-4 w-32 rounded bg-brand-mid/10" />
          <div className="h-3 w-40 rounded bg-brand-mid/10" />
        </div>
        <div className="space-y-2 text-right">
          <div className="h-5 w-16 rounded bg-brand-mid/10" />
          <div className="h-3 w-24 rounded bg-brand-mid/10" />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <div className="h-9 w-32 rounded-[10px] bg-brand-mid/10" />
      </div>
    </div>
  );
}

export default function PagosPage() {
  const [payments, setPayments] = useState<AgencyPaymentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await agencyPaymentApi.list({
        status: statusFilter === "all" ? undefined : statusFilter,
        page,
        limit: PAGE_SIZE,
      });
      setPayments(result.payments);
      setTotal(result.total);
    } catch (e) {
      setError(
        getApiErrorMessage(e, "No pudimos cargar los pagos. Intenta de nuevo."),
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleFilter = (value: StatusFilter) => {
    setStatusFilter(value);
    setPage(1);
  };

  const summary = useMemo(() => {
    const pending = payments.filter((p) => p.status === "pending").length;
    const verified = payments.filter((p) => p.status === "verified").length;
    const rejected = payments.filter((p) => p.status === "rejected").length;
    return { pending, verified, rejected };
  }, [payments]);

  return (
    <main className="flex-1 bg-[var(--color-page-bg)] pt-16">
      <div className="mx-auto max-w-[1600px] px-8 py-8">
        <div className="border-l-4 border-brand-cyan pl-3">
          <h1 className="text-[28px] font-extrabold text-brand-navy">
            Pagos
          </h1>
          <p className="mt-1 text-sm text-brand-muted">
            Revisa y verifica los comprobantes de tus reservas.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => handleFilter(tab.value)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
                statusFilter === tab.value
                  ? "bg-brand-cyan text-white"
                  : "bg-white text-brand-muted border border-[#e5e7eb] hover:bg-[#f1f5f9]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
                <Clock className="h-5 w-5 text-warning" />
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-brand-muted">
                  Pendientes
                </p>
                <p className="text-2xl font-bold text-brand-navy">
                  {summary.pending}
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
                <CheckCircle2 className="h-5 w-5 text-success" />
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-brand-muted">
                  Verificados
                </p>
                <p className="text-2xl font-bold text-brand-navy">
                  {summary.verified}
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
                <XCircle className="h-5 w-5 text-danger" />
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-brand-muted">
                  Rechazados
                </p>
                <p className="text-2xl font-bold text-brand-navy">
                  {summary.rejected}
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-bg">
                <CreditCard className="h-5 w-5 text-brand-cyan" />
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-brand-muted">
                  Total
                </p>
                <p className="text-2xl font-bold text-brand-navy">{total}</p>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-8 flex items-start gap-3 rounded-2xl border border-danger/20 bg-danger/5 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-danger">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => load()}
              className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 py-1.5 text-xs font-semibold text-danger border border-danger/20 transition-colors hover:bg-danger/10"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reintentar
            </button>
          </div>
        )}

        {loading ? (
          <div className="mt-8 grid gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={`sk-${i}`} />
            ))}
          </div>
        ) : payments.length === 0 && !error ? (
          <div className="mt-12 flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#e5e7eb] bg-brand-surface py-16">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cyan-bg">
              <CreditCard className="h-8 w-8 text-brand-cyan" />
            </div>
            <p className="mt-4 text-lg font-semibold text-brand-navy">
              No hay pagos {statusFilter === "all" ? "" : statusFilter === "pending" ? "pendientes" : statusFilter === "verified" ? "verificados" : "rechazados"} por revisar
            </p>
            <p className="mt-1 max-w-sm text-center text-sm text-brand-muted">
              Cuando un cliente envíe un comprobante de pago para tu agencia, aparecerá aquí.
            </p>
            <button
              type="button"
              onClick={() => {
                handleFilter("all");
                load();
              }}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw className="h-4 w-4" />
              Ver todos los pagos
            </button>
          </div>
        ) : (
          <div className="mt-8 grid gap-4">
            {payments.map((payment) => (
              <Link
                key={payment.id}
                href={`/pagos/${payment.id}`}
                className="block"
              >
                <PaymentCard
                  payment={payment}
                  onView={() => {
                    /* navigation handled by Link wrapper */
                  }}
                />
              </Link>
            ))}
          </div>
        )}

        {!loading && totalPages > 1 && (
          <div className="mt-8 flex items-center justify-between">
            <p className="text-sm text-brand-muted">
              Página {page} de {totalPages}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-4 py-2 text-sm font-semibold text-brand-navy border border-[#e5e7eb] transition-colors hover:bg-[#f1f5f9] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft className="h-4 w-4" />
                Anterior
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-4 py-2 text-sm font-semibold text-brand-navy border border-[#e5e7eb] transition-colors hover:bg-[#f1f5f9] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Siguiente
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
