'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Copy,
  Landmark,
  LoaderCircle,
  MessageCircle,
  Phone,
} from 'lucide-react';
import {
  checkoutApi,
  type CheckoutPaymentMethodsView,
  type CheckoutPagoMovilData,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { copyToClipboard, whatsappHref } from '@/lib/booking/whatsapp';

interface PaymentMethodSectionProps {
  attemptId: string;
  /** Notifica al padre el canal elegido (null = aún sin elegir). */
  onSelectionChange: (methodId: string | null) => void;
}

const WHATSAPP_NOTICE =
  'Puedes contactar a la agencia por WhatsApp para recibir ayuda con tu pago. Enviar el comprobante únitamente por WhatsApp no confirma tu reserva.';

function describePagoMovil(data: CheckoutPagoMovilData): string[] {
  const lines: string[] = [];
  if (data.bank_name) {
    lines.push(data.bank_code ? `${data.bank_name} (${data.bank_code})` : data.bank_name);
  }
  if (data.phone) lines.push(`Teléfono ${data.phone}`);
  if (data.holder_name) {
    const doc =
      data.document_type && data.document_number
        ? `${data.document_type}-${data.document_number}`
        : '';
    lines.push(`${data.holder_name}${doc ? ` · ${doc}` : ''}`);
  }
  if (data.account_type || data.account_number) {
    const parts = [
      data.account_type === 'checking' ? 'Cuenta corriente' : data.account_type === 'savings' ? 'Cuenta de ahorro' : '',
      data.account_number ?? '',
    ].filter(Boolean);
    lines.push(parts.join(' · '));
  }
  return lines.filter(Boolean);
}

function SkeletonRows() {
  return (
    <div className="mt-4 space-y-3" aria-hidden="true">
      <div className="h-[88px] animate-pulse rounded-[10px] bg-black/[0.06]" />
      <div className="h-[88px] animate-pulse rounded-[10px] bg-black/[0.06]" />
    </div>
  );
}

/**
 * MKT-007.4 — Sección "Datos de pago": canales de pago móvil de la agencia,
 * elegidos ANTES de subir el comprobante. El importe mostrado es el del
 * intento (amount_cents), nunca un total recalculado por el frontend.
 *
 * Mientras status='created' el cliente puede cambiar de canal; una vez
 * enviado el primer comprobante el canal queda congelado (solo lectura).
 */
export function PaymentMethodSection({
  attemptId,
  onSelectionChange,
}: PaymentMethodSectionProps) {
  const [view, setView] = useState<CheckoutPaymentMethodsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const notifiedRef = useRef<string | null | undefined>(undefined);

  const notify = useCallback(
    (methodId: string | null) => {
      if (notifiedRef.current === methodId) return;
      notifiedRef.current = methodId;
      onSelectionChange(methodId);
    },
    [onSelectionChange],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await checkoutApi.getPaymentMethods(attemptId);
      setView(result);
      notify(result.selected_method_id);
    } catch (error) {
      setLoadError(
        getApiErrorMessage(error, 'No pudimos cargar los métodos de pago.'),
      );
    } finally {
      setLoading(false);
    }
  }, [attemptId, notify]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  const handleSelect = async (methodId: string) => {
    if (selectingId) return;
    setSelectingId(methodId);
    try {
      const result = await checkoutApi.selectPaymentMethod(attemptId, methodId);
      setView((current) =>
        current
          ? {
              ...current,
              selected_method_id: result.payment_method_id,
              status: result.status,
            }
          : current,
      );
      notify(result.payment_method_id);
      toast.success('Método de pago seleccionado');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CHECKOUT_PAYMENT_METHOD_FROZEN') {
        toast.error('El método de pago de esta compra ya no se puede cambiar');
        void load();
        return;
      }
      toast.error(getApiErrorMessage(error, 'No se pudo seleccionar el método de pago'));
    } finally {
      setSelectingId(null);
    }
  };

  const handleCopy = async (text: string, key: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedId(key);
      toast.success('Copiado al portapapeles');
      window.setTimeout(() => setCopiedId((current) => (current === key ? null : current)), 2000);
    } else {
      toast.error('No se pudo copiar. Copia el dato manualmente.');
    }
  };

  const agencyWhatsApp = whatsappHref(view?.agency_phone ?? null);
  const editable = view?.status === 'created';
  const selected = view?.methods.find((m) => m.id === view.selected_method_id) ?? null;

  return (
    <div className="mt-5 rounded-[10px] border border-black/[0.06] bg-[#f8fafc] px-4 py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[15px] font-semibold text-brand-navy">
          Datos de pago
        </h3>
        {view ? (
          <span className="text-xs font-semibold text-brand-navy">
            Importe a transferir:{' '}
            <span className="text-[15px] font-extrabold">
              {formatSeatPrice(view.amount_cents)}
            </span>
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-brand-muted">
        Transfiere el importe exacto a la cuenta de la agencia y luego envía
        tu comprobante.
      </p>

      {loading && <SkeletonRows />}

      {!loading && loadError && (
        <div className="mt-4 flex flex-col items-start gap-3">
          <p className="text-sm font-semibold text-[#ef4444]">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
          >
            Reintentar
          </button>
        </div>
      )}

      {!loading && !loadError && view && view.methods.length === 0 && (
        <div className="mt-4 rounded-[10px] bg-[#fffbeb] px-4 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={18}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0 text-[#92400e]"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-[#92400e]">
                La agencia aún no tiene un método de pago configurado
              </p>
              {view.agency_phone ? (
                <>
                  <p className="mt-1 text-xs text-brand-muted">{WHATSAPP_NOTICE}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {agencyWhatsApp ? (
                      <a
                        href={agencyWhatsApp}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-[10px] bg-[#10b981] px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#059669]"
                      >
                        <MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" />
                        Contactar por WhatsApp
                      </a>
                    ) : (
                      <p className="text-xs text-brand-muted">
                        No pudimos abrir WhatsApp con este número. Cópialo y
                        contáctalos manualmente.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleCopy(view.agency_phone!, 'agency-phone')}
                      className="inline-flex items-center gap-2 rounded-[10px] bg-white border border-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#f1f5f9]"
                    >
                      {copiedId === 'agency-phone' ? (
                        <CheckCircle2 size={16} strokeWidth={1.75} className="text-[#10b981]" aria-hidden="true" />
                      ) : (
                        <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
                      )}
                      Copiar teléfono: {view.agency_phone}
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs text-brand-muted">
                  Tampoco ha publicado un medio de contacto disponible en este
                  momento. Elige un método de pago para continuar cuando la
                  agencia lo habilite.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && !loadError && view && view.methods.length > 0 && (
        <div className="mt-4 space-y-3">
          {view.methods.map((method) => {
            const isSelected = method.id === view.selected_method_id;
            const busy = selectingId === method.id;
            const anyBusy = selectingId !== null;
            const readOnly = !editable;
            return (
              <div
                key={method.id}
                data-testid={`payment-method-${method.id}`}
                className={`rounded-[10px] border bg-white px-4 py-3 transition-colors duration-200 ${
                  isSelected
                    ? 'border-brand-cyan'
                    : 'border-black/[0.06]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Landmark size={16} strokeWidth={1.75} className="text-brand-muted" aria-hidden="true" />
                      <span className="text-sm font-semibold text-brand-navy">
                        {method.label}
                      </span>
                      {isSelected && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-[11px] font-semibold text-[#059669]">
                          <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
                          Seleccionado
                        </span>
                      )}
                    </div>
                    <ul className="mt-2 space-y-1">
                      {describePagoMovil(method.data).map((line, index) => (
                        <li
                          key={index}
                          className="flex items-center gap-2 text-xs text-brand-muted"
                        >
                          {index === 1 ? (
                            <Phone size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                          ) : index === 0 ? (
                            <Building2 size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {method.data.phone ? (
                      <button
                        type="button"
                        onClick={() => void handleCopy(method.data.phone, `phone-${method.id}`)}
                        className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#f1f5f9] px-2.5 py-1.5 text-[11px] font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                        aria-label="Copiar teléfono de la cuenta"
                      >
                        {copiedId === `phone-${method.id}` ? (
                          <CheckCircle2 size={12} strokeWidth={1.75} className="text-[#10b981]" aria-hidden="true" />
                        ) : (
                          <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                        )}
                        Copiar teléfono
                      </button>
                    ) : null}
                    {editable && !isSelected ? (
                      <button
                        type="button"
                        onClick={() => void handleSelect(method.id)}
                        disabled={anyBusy}
                        className="inline-flex items-center gap-1.5 rounded-[8px] bg-brand-cyan px-3 py-1.5 text-[12px] font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busy ? (
                          <LoaderCircle size={12} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
                        ) : null}
                        {busy ? 'Seleccionando…' : 'Elegir'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
          {!editable && selected ? (
            <p className="text-[12px] text-brand-muted">
              Este método quedó guardado cuando enviaste tu comprobante y ya no
              puede cambiarse.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
