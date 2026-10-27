'use client';

import { useMemo, useId } from 'react';
import { motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DayPickerCalendar } from '@/components/ui/day-picker-calendar';

const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DEFAULT_TIME = '07:00';

export interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  label?: string;
}

function parseNaiveDateTime(value: string): { date: Date | undefined; time: string } {
  if (!value) return { date: undefined, time: '' };
  const match = value.match(NAIVE_DATETIME_RE);
  if (!match) return { date: undefined, time: '' };
  const [, y, m, d, h, min] = match;
  return {
    date: new Date(Number(y), Number(m) - 1, Number(d)),
    time: `${h}:${min}`,
  };
}

function formatNaiveDateTime(date: Date, time: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const [h, min = '00'] = time.split(':');
  return `${y}-${m}-${d}T${h.padStart(2, '0')}:${min.padStart(2, '0')}`;
}

const inputClassName =
  'w-full border-[1.5px] border-[#e5e7eb] rounded-xl px-4 py-3 font-[family-name:var(--font-body)] font-normal text-sm text-[var(--color-brand-navy)] bg-white outline-none transition-all duration-200 focus:border-[var(--color-brand-cyan)] focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)] disabled:opacity-40 disabled:cursor-not-allowed';

export function DateTimePicker({
  value,
  onChange,
  disabled = false,
  error,
  label,
}: DateTimePickerProps) {
  const pickerId = useId();
  const { date: selectedDate, time } = useMemo(() => parseNaiveDateTime(value), [value]);

  const handleDateSelect = (date: Date | undefined) => {
    if (!date || disabled) return;
    onChange(formatNaiveDateTime(date, time || DEFAULT_TIME));
  };

  const handleTimeChange = (nextTime: string) => {
    if (disabled) return;
    if (!selectedDate) return;
    onChange(formatNaiveDateTime(selectedDate, nextTime));
  };

  return (
    <div className="flex flex-col gap-3 w-fit max-w-full mx-auto">
      {label && (
        <label
          htmlFor={pickerId}
          className="font-[family-name:var(--font-body)] font-medium text-xs text-[var(--color-brand-muted)] uppercase tracking-wider"
        >
          {label}
        </label>
      )}

      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className={cn(
          'rounded-2xl border border-[rgba(0,0,0,0.06)] bg-[var(--color-brand-surface)] p-3 sm:p-4',
          error && 'border-[#ef4444]',
          disabled && 'opacity-60 pointer-events-none',
        )}
      >
        <DayPickerCalendar
          size="default"
          selected={selectedDate}
          onSelect={handleDateSelect}
          defaultMonth={selectedDate}
          disabled={disabled}
        />
      </motion.div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`${pickerId}-time`}
          className="font-[family-name:var(--font-body)] font-medium text-xs text-[var(--color-brand-muted)] uppercase tracking-wider"
        >
          Hora
        </label>
        <div className="relative">
          <Clock
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-brand-muted)] pointer-events-none"
            strokeWidth={1.75}
          />
          <input
            id={`${pickerId}-time`}
            type="time"
            value={time}
            onChange={(e) => handleTimeChange(e.target.value)}
            disabled={disabled || !selectedDate}
            className={cn(
              inputClassName,
              'pl-10',
              error && 'border-[#ef4444] focus:border-[#ef4444] focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15)]',
            )}
          />
        </div>
        {(!selectedDate || error) && (
          <div className="min-h-[18px]">
            {!selectedDate && (
              <p className="font-[family-name:var(--font-body)] font-normal text-[12px] text-[var(--color-brand-muted)]">
                Selecciona una fecha para habilitar la hora.
              </p>
            )}
            {error && (
              <p className="font-[family-name:var(--font-body)] font-normal text-[12px] text-[#ef4444]">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
