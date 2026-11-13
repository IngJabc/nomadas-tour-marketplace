import type { CSSProperties } from 'react';
import { safeHexColor } from './AgencyLogo';

// ── Branding de agencia (colores públicos de `agency_settings`) ─────────────
//
// Los tres colores de la agencia (primary/secondary/accent) ya viajan en la
// API pública del Marketplace; aquí se aplican al UI como variables CSS
// AISLADAS por contenedor (perfil de agencia / tarjeta del directorio):
//
//   · Solo se emiten las variables cuyo valor pasa `safeHexColor`: un color
//     ausente o inválido jamás se pinta y el consumidor resuelve el fallback
//     a la token oficial del Marketplace (`--color-brand-cyan` /
//     `--color-brand-blue`), que es el aspecto por defecto.
//   · `-ink`: tinta de máximo contraste SOBRE el color (fondos sólidos con
//     texto, p. ej. el CTA "Reservar").
//   · `-text`: versión legible SOBRE blanco (texto/iconos pequeños), para
//     que un color claro de la agencia no quede invisible en la tarjeta.
//
// Nada de esto cambia el layout: solo variables y clases de color.

/** Tinta más oscura de la marca (respaldo de contraste). */
const BRAND_DARK = '#14181F';
const WHITE = '#FFFFFF';
/** Contraste mínimo AA (WCAG 2.2) para texto normal sobre fondo claro. */
const AA_RATIO = 4.5;

export interface AgencyBrandColors {
  primary_color?: string | null;
  secondary_color?: string | null;
  accent_color?: string | null;
}

/** Objeto de `style` que además porta custom properties (`--agency-*`). */
type BrandStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * Hex (3/4/6/8 dígitos) → RGB. El canal alfa se ignora para el cálculo de
 * contraste (los colores con alfa parcial son un caso raro de la API y el
 * comportamiento sigue siendo "mejor esfuerzo", nunca un error).
 */
function parseHexRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]+)$/.exec(hex.trim());
  if (!match) return null;
  let body = match[1];
  if (body.length === 3 || body.length === 4) {
    body = body
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  } else if (body.length === 8) {
    body = body.slice(0, 6);
  } else if (body.length !== 6) {
    return null;
  }
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

/** Luminancia relativa WCAG (sRGB → lineal → ponderada). */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(from[0] * (1 - t) + to[0] * t),
    Math.round(from[1] * (1 - t) + to[1] * t),
    Math.round(from[2] * (1 - t) + to[2] * t),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/**
 * Tinta legible SOBRE el color: la que logra mayor contraste entre el blanco
 * y la tinta de marca. Se usa para texto encima de fondos sólidos (CTA).
 * Entradas ilegibles (nunca ocurren: el llamador valida con `safeHexColor`)
 * caen al blanco, el respaldo neutro.
 */
function readableInk(color: string): string {
  const rgb = parseHexRgb(color);
  if (!rgb) return WHITE;
  const inkRgb = parseHexRgb(BRAND_DARK);
  if (!inkRgb) return WHITE;
  const luminance = relativeLuminance(rgb);
  const onWhite = contrastRatio(luminance, 1);
  const onInk = contrastRatio(luminance, relativeLuminance(inkRgb));
  return onWhite >= onInk ? WHITE : BRAND_DARK;
}

/**
 * Versión del color legible SOBRE blanco: si ya alcanza AA (4.5:1) se
 * devuelve tal cual; si no, se oscurece mezclando hacia la tinta de marca
 * hasta cumplir el contraste. Así un color claro de la agencia nunca deja
 * texto o iconos invisibles sobre las tarjetas claras.
 */
function readableOnLight(color: string): string {
  const rgb = parseHexRgb(color);
  const inkRgb = parseHexRgb(BRAND_DARK);
  if (!rgb || !inkRgb) return color;
  const meets = (c: [number, number, number]) =>
    contrastRatio(relativeLuminance(c), 1) >= AA_RATIO;
  if (meets(rgb)) return color;
  // Búsqueda binaria del punto exacto donde se alcanza AA (t=1 siempre
  // cumple: es la tinta de marca, con contraste ~17:1 sobre blanco).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const t = (lo + hi) / 2;
    if (meets(mix(rgb, inkRgb, t))) hi = t;
    else lo = t;
  }
  return toHex(mix(rgb, inkRgb, hi));
}

/**
 * Variables CSS de la agencia para el `style` del contenedor que la
 * representa (perfil público o tarjeta del directorio). Cada consumidor las
 * referencia con fallback a la token del Marketplace, p. ej.
 * `bg-[var(--agency-primary,var(--color-brand-cyan))]`: fuera del contenedor
 * (o con la agencia sin colores) el aspecto no cambia.
 *
 * El aislamiento es por construcción: cada agencia solo emite sus variables
 * en su propio contenedor, nunca en un ancestro compartido.
 */
export function agencyBrandVars(
  colors: AgencyBrandColors | null | undefined,
): CSSProperties {
  if (!colors) return {};
  const vars: BrandStyle = {};

  const primary = safeHexColor(colors.primary_color);
  if (primary) {
    vars['--agency-primary'] = primary;
    vars['--agency-primary-ink'] = readableInk(primary);
    vars['--agency-primary-text'] = readableOnLight(primary);
  }

  const secondary = safeHexColor(colors.secondary_color);
  if (secondary) {
    vars['--agency-secondary'] = secondary;
    vars['--agency-secondary-ink'] = readableInk(secondary);
  }

  const accent = safeHexColor(colors.accent_color);
  if (accent) {
    vars['--agency-accent'] = accent;
    vars['--agency-accent-ink'] = readableInk(accent);
  }

  return vars;
}
