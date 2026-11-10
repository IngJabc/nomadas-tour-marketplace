'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowRight, Bus, Star } from 'lucide-react';
import type { PublicAgency } from '@/lib/api';
import { AgencyLogo, safeHexColor } from './AgencyLogo';
import { AgencyRatingsSummary } from './AgencyRatingsSummary';
import { tripsSummaryLabel } from './tripsSummary';

interface AgencyCardProps {
  agency: PublicAgency;
  /** Posición en la lista: usada para escalonar la entrada de las tarjetas. */
  index?: number;
}

/**
 * Tarjeta del directorio público (REP-001). Conserva el ORDEN que entrega el
 * backend (destacadas primero) y lo hace visible con la píldora "Destacada":
 * aquí no se reordena ni se recalcula ningún ranking.
 */
export function AgencyCard({ agency, index = 0 }: AgencyCardProps) {
  const tint =
    safeHexColor(agency.primary_color) ??
    safeHexColor(agency.secondary_color) ??
    safeHexColor(agency.accent_color);
  const trips = agency.published_trips_count;

  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.35,
        delay: Math.min(index * 0.06, 0.3),
        ease: 'easeOut',
      }}
      whileHover={{ y: -4 }}
      className="relative flex flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-brand-surface p-6 pt-7 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]"
    >
      {/* Franja de marca: color público de la agencia (si lo publicó). */}
      {tint && (
        <span
          data-testid="agency-branding-strip"
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-1.5"
          style={{ backgroundColor: tint }}
        />
      )}

      <div className="flex items-start gap-3">
        <AgencyLogo
          logoUrl={agency.logo_url}
          name={agency.name}
          primaryColor={agency.primary_color}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold leading-snug text-brand-navy">
              {agency.name}
            </h2>
            {agency.is_featured && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-cyan-bg)] px-2.5 py-0.5 text-[11px] font-semibold text-brand-cyan">
                <Star size={11} strokeWidth={2} fill="currentColor" aria-hidden />
                Destacada
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-[10px] bg-[#F5F1EC] px-4 py-3">
        <AgencyRatingsSummary ratings={agency.ratings} />
      </div>

      <p className="mt-3 flex items-center gap-2 text-sm">
        <Bus size={16} strokeWidth={1.75} className="shrink-0 text-brand-cyan" aria-hidden />
        <span className="text-[15px] font-semibold text-brand-navy">
          {tripsSummaryLabel(trips, false)}
        </span>
      </p>

      <div className="mt-auto pt-5">
        <Link
          href={`/agencies/${agency.id}`}
          aria-label={`Ver perfil de ${agency.name}`}
          className="block w-full rounded-[10px] bg-brand-cyan px-5 py-3 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
        >
          Ver perfil
        </Link>
      </div>
    </motion.article>
  );
}
