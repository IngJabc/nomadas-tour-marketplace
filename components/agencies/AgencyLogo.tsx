'use client';

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';

// ── REP-001 · Logo de agencia (directorio y perfil público) ────────────────
//
// El branding (`agency_settings`, 041) es un dato PÚBLICO de la agencia. Los
// colores vienen de la base de datos, así que NUNCA se pintan a mano: se
// validan antes de usarlos en un estilo inline para que un valor roto solo
// deje el respaldo por defecto, no rompa la tarjeta.

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Devuelve el color solo si es un hex válido; nunca se confía en el dato crudo. */
export function safeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
}

interface AgencyLogoProps {
  logoUrl: string | null;
  name: string;
  /** Color de marca preferido para el respaldo (sin logo o logo caído). */
  primaryColor?: string | null;
  size?: number;
}

/**
 * Logo de agencia con respaldo: si no hay `logo_url` (o la imagen falla al
 * cargar) se muestra el icono de marca sobre un tinte del color principal.
 * El alt nombra a la agencia; el respaldo es decorativo (aria-hidden).
 */
export function AgencyLogo({
  logoUrl,
  name,
  primaryColor,
  size = 48,
}: AgencyLogoProps) {
  const [failed, setFailed] = useState(false);
  const tint = safeHexColor(primaryColor);

  // Un logo nuevo (otra agencia) vuelve a intentar cargar.
  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);

  const dimensions = { width: size, height: size };

  if (logoUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logos remotos
      // de agencias: dominios arbitrarios, fuera de la config de imágenes.
      <img
        src={logoUrl}
        alt={`Logo de ${name}`}
        onError={() => setFailed(true)}
        style={dimensions}
        className="shrink-0 rounded-[10px] object-cover"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...dimensions,
        ...(tint
          ? { backgroundColor: `color-mix(in srgb, ${tint} 18%, #FFFFFF)` }
          : { backgroundColor: '#F5F1EC' }),
      }}
      className="flex shrink-0 items-center justify-center rounded-[10px]"
    >
      <Building2
        size={Math.round(size * 0.45)}
        strokeWidth={1.75}
        style={tint ? { color: tint } : undefined}
        className={tint ? '' : 'text-brand-navy'}
      />
    </span>
  );
}
