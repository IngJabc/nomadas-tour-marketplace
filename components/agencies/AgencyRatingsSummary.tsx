'use client';

import { Star } from 'lucide-react';
import type { AgencyRatingStat, AgencyRatings } from '@/lib/api';

// ── REP-001 · Calificaciones de agencia, SIEMPRE separadas ─────────────────
//
// El backend nunca calcula un promedio combinado: `ratings.agency` (reseñas
// de la agencia) y `ratings.trip` (reseñas de sus viajes) son dos
// estadísticas independientes y aquí se presentan como tales. `average: null`
// significa "sin calificar" (sin reseñas visibles, o tablas de reseñas aún no
// aplicadas) y JAMÁS se muestra como 0.

interface AgencyRatingsSummaryProps {
  ratings: AgencyRatings;
  /**
   * `compact` → dos filas dentro de una caja (tarjeta del directorio).
   * `panel`   → dos mosaículos con el número como héroe (perfil público).
   */
  variant?: 'compact' | 'panel';
}

function ratingValue(stat: AgencyRatingStat): string | null {
  if (stat.average === null || stat.count <= 0) return null;
  return stat.average.toFixed(1);
}

function ratingCountLabel(stat: AgencyRatingStat): string {
  if (stat.count <= 0) return 'Aún sin reseñas';
  return `${stat.count} reseña${stat.count === 1 ? '' : 's'}`;
}

export function AgencyRatingsSummary({
  ratings,
  variant = 'compact',
}: AgencyRatingsSummaryProps) {
  const blocks = [
    {
      key: 'agency' as const,
      label: variant === 'panel' ? 'Calificación de la agencia' : 'Agencia',
      stat: ratings.agency,
    },
    {
      key: 'trip' as const,
      label: variant === 'panel' ? 'Calificación de sus viajes' : 'Viajes',
      stat: ratings.trip,
    },
  ];

  if (variant === 'panel') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {blocks.map((block) => {
          const value = ratingValue(block.stat);
          return (
            <div
              key={block.key}
              className="rounded-[10px] bg-[#F5F1EC] px-4 py-3"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase text-brand-muted">
                <Star
                  size={12}
                  strokeWidth={1.75}
                  className="text-brand-cyan"
                  aria-hidden
                />
                {block.label}
              </span>
              <span className="mt-1.5 flex items-baseline gap-2">
                <span
                  className={`text-[22px] font-extrabold leading-none ${
                    value ? 'text-brand-navy' : 'text-brand-muted'
                  }`}
                >
                  {value ?? 'Sin reseñas'}
                </span>
                <span className="text-xs text-brand-muted">
                  {value ? ratingCountLabel(block.stat) : ''}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {blocks.map((block) => {
        const value = ratingValue(block.stat);
        return (
          <div
            key={block.key}
            className="flex items-center justify-between gap-2"
          >
            <span className="text-[11px] font-medium uppercase text-brand-muted">
              {block.label}
            </span>
            <span className="flex items-center gap-1.5">
              <Star
                size={13}
                strokeWidth={1.75}
                className="text-brand-cyan"
                aria-hidden
              />
              <span
                className={`text-sm ${value ? 'font-bold text-brand-navy' : 'font-medium text-brand-muted'}`}
              >
                {value ?? 'Sin reseñas'}
              </span>
              {value && (
                <span className="text-[11px] text-brand-muted">
                  {ratingCountLabel(block.stat)}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
