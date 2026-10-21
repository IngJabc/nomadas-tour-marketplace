'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toPng } from 'html-to-image';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  LogIn,
  ShieldAlert,
  Ticket,
} from 'lucide-react';
import { checkoutApi, type CheckoutTicketView } from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import { PurchaseTicket } from '@/components/compras/PurchaseTicket';

const COMPRAS_PATH = '/cuenta/compras';
const LOGIN_PATH = '/login?redirect=%2Fcuenta%2Fcompras';

function SkeletonTicket() {
  return (
    <div
      role="status"
      className="rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
    >
      <span className="sr-only">Cargando tu boleto…</span>
      <div className="h-6 w-48 rounded-full bg-black/[0.06]" />
      <div className="mt-4 h-4 w-64 rounded bg-black/[0.06]" />
      <div className="mx-auto mt-8 h-64 w-64 rounded-2xl bg-black/[0.06]" />
      <div className="mt-8 h-12 w-full rounded-[10px] bg-black/[0.06]" />
    </div>
  );
}

export default function BoletoPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const role = user?.role ?? null;

  const params = useParams<{ attemptId: string }>();
  const attemptId = params?.attemptId ?? '';

  const [ticket, setTicket] = useState<CheckoutTicketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** true cuando el backend respondió 404: boleto no disponible. */
  const [notFound, setNotFound] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  /** Captura del boleto renderizado (mismo nodo que ve el usuario). */
  const captureRef = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setSessionExpired(false);
    setDownloadError(null);
    try {
      const data = await checkoutApi.getTicket(attemptId);
      if (seq !== seqRef.current) return;
      setTicket(data);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else if (e instanceof ApiError && e.status === 404) {
        // 404 uniforme: inexistente, ajeno o no elegible. No se distingue.
        setNotFound(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar tu boleto. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [attemptId]);

  useEffect(() => {
    seqRef.current += 1;
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setSessionExpired(true);
      setTicket(null);
      setLoading(false);
      return;
    }
    if (user.role !== 'customer') {
      setTicket(null);
      setLoading(false);
      return;
    }
    void load();
  }, [authLoading, user, role, load]);

  // Descarga = captura PNG del boleto tal como se ve (modelo Tour:
  // useCapture + html-to-image.toPng con pixelRatio 2 y fondo blanco).
  const handleDownload = async () => {
    if (!captureRef.current || downloading || !ticket) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const dataUrl = await toPng(captureRef.current, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#ffffff',
      });
      if (!dataUrl) throw new Error('capture-failed');
      const link = document.createElement('a');
      // El nombre usa solo el ticket_code (hex corto y ya validado por el
      // backend); nunca el qr_code crudo, que puede contener acentos/espacios
      // y filtrarse en el filesystem o en logs del navegador.
      link.href = dataUrl;
      link.download = `boleto-${ticket.ticket_code}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      setDownloadError(
        'No se pudo descargar la imagen. Intenta de nuevo.',
      );
    } finally {
      setDownloading(false);
    }
  };

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  let view: 'loading' | 'session' | 'role' | 'error' | 'notfound' | 'ticket';
  if (authLoading || (loading && ticket === null && !error && !sessionExpired && !notFound && !roleBlocked)) {
    view = 'loading';
  } else if (sessionExpired) {
    view = 'session';
  } else if (roleBlocked) {
    view = 'role';
  } else if (notFound) {
    view = 'notfound';
  } else if (ticket === null && error) {
    view = 'error';
  } else if (ticket === null) {
    view = 'loading';
  } else {
    view = 'ticket';
  }

  const backLink = (label: string, primary = false) => (
    <Link
      href={COMPRAS_PATH}
      className={
        primary
          ? 'mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue'
          : 'inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]'
      }
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      {label}
    </Link>
  );

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 sm:px-8 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Tu boleto</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Presenta este código al abordar. Un boleto por reserva.
        </p>
      </div>

      <div className="mt-8" aria-live="polite">
        {view === 'loading' && <SkeletonTicket />}

        {view === 'session' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
              <ShieldAlert size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Tu sesión ya no está activa
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Inicia sesión de nuevo para ver tu boleto.
            </p>
            <Link
              href={LOGIN_PATH}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <LogIn size={16} strokeWidth={1.75} aria-hidden />
              Iniciar sesión
            </Link>
          </div>
        )}

        {view === 'role' && (
          <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
              <p className="text-sm font-semibold text-[#92400e]">
                Solo las cuentas de cliente pueden ver sus boletos.
              </p>
              <p className="mt-1 text-xs text-brand-muted">
                Tu sesión actual no es una cuenta de cliente, así que este
                boleto no le corresponde.
              </p>
            </div>
            <div className="mt-4">{backLink('Volver a mis compras')}</div>
          </div>
        )}

        {view === 'notfound' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9] text-brand-muted">
              <Ticket size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Boleto no disponible
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Esta compra aún no tiene un boleto disponible. El boleto se
              habilita cuando la agencia aprueba el pago completo de la
              reserva.
            </p>
            {backLink('Volver a mis compras', true)}
          </div>
        )}

        {view === 'error' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2] text-[#ef4444]">
              <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No pudimos cargar tu boleto
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={load}
                className="rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                Reintentar
              </button>
              {backLink('Volver a mis compras')}
            </div>
          </div>
        )}

        {view === 'ticket' && ticket && (
          <div className="mx-auto max-w-[32rem]">
            <PurchaseTicket ref={captureRef} ticket={ticket} />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#f1f5f9] px-3 py-2">
              <span className="text-[11px] font-medium uppercase text-brand-muted">
                Importe pagado
              </span>
              <span className="text-[17px] font-extrabold leading-none text-brand-navy">
                {formatSeatPrice(ticket.amount_cents)}
              </span>
            </div>
            <p className="mt-2 text-center text-xs text-brand-muted">
              Reserva del {formatDateTimeShort(ticket.reservation_created_at)}
            </p>

            {downloadError && (
              <p className="mt-4 rounded-[10px] bg-[#fef2f2] px-3 py-2 text-xs font-medium text-[#ef4444]">
                {downloadError}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download size={16} strokeWidth={1.75} aria-hidden />
                {downloading ? 'Preparando…' : 'Descargar'}
              </button>
              {backLink('Volver a mis compras')}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
