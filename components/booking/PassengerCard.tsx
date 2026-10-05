'use client';

import type { PassengerDraft } from '@/lib/booking/lock-state';
import type { PassengerError } from '@/lib/booking/passengers';

interface PassengerCardProps {
  seatCode: string;
  index: number;
  passenger: PassengerDraft;
  errors: PassengerError[];
  disabled: boolean;
  onChange: (passenger: PassengerDraft) => void;
}

const inputClass =
  'w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm text-brand-navy outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)] disabled:bg-[#f8fafc]';

function Field({
  id,
  label,
  value,
  placeholder,
  error,
  disabled,
  onChange,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  inputMode?: 'text' | 'numeric' | 'tel';
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[12px] font-medium uppercase text-brand-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} ${error ? 'border-[#ef4444]' : ''}`}
      />
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 text-[12px] font-medium text-[#ef4444]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PassengerCard({
  seatCode,
  index,
  passenger,
  errors,
  disabled,
  onChange,
}: PassengerCardProps) {
  const errorFor = (field: PassengerError['field']) =>
    errors.find((error) => error.index === index && error.field === field)
      ?.message;

  const patch = (partial: Partial<PassengerDraft>) =>
    onChange({ ...passenger, ...partial });

  return (
    <article className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="border-l-4 border-brand-cyan pl-3 text-[17px] font-semibold text-brand-navy">
          Pasajero {index + 1}
        </h3>
        <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
          Asiento {seatCode}
        </span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field
          id={`passenger-${index}-first-name`}
          label="Nombre"
          value={passenger.first_name}
          placeholder="María"
          error={errorFor('first_name')}
          disabled={disabled}
          onChange={(value) => patch({ first_name: value })}
        />
        <Field
          id={`passenger-${index}-last-name`}
          label="Apellido"
          value={passenger.last_name}
          placeholder="González"
          error={errorFor('last_name')}
          disabled={disabled}
          onChange={(value) => patch({ last_name: value })}
        />
        <Field
          id={`passenger-${index}-document`}
          label="Cédula / Documento"
          value={passenger.document}
          placeholder="12345678"
          inputMode="numeric"
          error={errorFor('document')}
          disabled={disabled}
          onChange={(value) => patch({ document: value })}
        />
        <Field
          id={`passenger-${index}-phone`}
          label="Teléfono"
          value={passenger.phone}
          placeholder="04241234567"
          inputMode="tel"
          error={errorFor('phone')}
          disabled={disabled}
          onChange={(value) => patch({ phone: value })}
        />
      </div>
    </article>
  );
}
