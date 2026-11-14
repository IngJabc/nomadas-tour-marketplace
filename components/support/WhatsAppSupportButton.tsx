'use client';

import { motion } from 'framer-motion';
import { usePathname } from 'next/navigation';
import { FAB_MOTION } from '@/components/ui/fab-motion';
import { useSupportMessageContext } from '@/components/support/SupportMessageProvider';
import {
  supportMessageCategoryFromPath,
  supportWhatsAppHref,
} from '@/lib/support/whatsapp-support';

/**
 * Glifo oficial de WhatsApp (burbuja + auricular). Lucide no incluye
 * iconos de marca, así que se usa el SVG real del logo en lugar de un
 * icono genérico como `MessageCircle`. Path canónico del set
 * simple-icons (24×24, `fill: currentColor`).
 */
const WHATSAPP_GLYPH_PATH =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z';

/**
 * SUP-002 — Botón flotante global de soporte por WhatsApp.
 *
 * Se monta una sola vez en `app/layout.tsx`, así que aparece en toda la
 * app. Comportamiento:
 *
 * - **Contexto (SUP-003):** usa la categoría/identificadores que la
 *   pantalla haya declarado con `useSupportMessage`; si no hay contexto,
 *   deriva la categoría de la ruta.
 * - **Sin número configurado (SUP-001):** devuelve `null` — sin enlace
 *   roto ni botón muerto.
 * - **Posición:** esquina inferior DERECHA (`bottom-6 right-6`), debajo
 *   (`z-40`) del navbar y los modales (`z-50`). El "volver arriba" se
 *   apila ARRIBA (`bottom-24`), así que nunca se solapan; los toasts
 *   (abajo a la derecha) son transitorios, igual que con el preexistente
 *   "volver arriba". Solo el logo (sin texto), círculo 48px.
 * - **Animación (FAB_MOTION):** hover con scale sutil + sombra y
 *   click comprimido, igual que "volver arriba".
 * - **Accesible:** enlace con `aria-label` explícito, foco visible y
 *   `target="_blank" rel="noopener noreferrer"`.
 */
export function WhatsAppSupportButton() {
  const pathname = usePathname();
  const context = useSupportMessageContext();

  const category =
    context?.category ?? supportMessageCategoryFromPath(pathname);
  const href = supportWhatsAppHref(category, context?.identifiers);

  if (!href) return null;

  return (
    <motion.a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Contactar al soporte por WhatsApp"
      data-testid="whatsapp-support-button"
      {...FAB_MOTION}
      className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[#10b981] text-white shadow-lg transition-shadow duration-200 hover:shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-surface)]"
    >
      <svg
        viewBox="0 0 24 24"
        width={26}
        height={26}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d={WHATSAPP_GLYPH_PATH} />
      </svg>
    </motion.a>
  );
}
