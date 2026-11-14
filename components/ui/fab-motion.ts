import type { MotionProps } from 'framer-motion';

/**
 * Animación compartida de los botones flotantes (FAB) del marketplace:
 * hover con un scale sutil y click/compress comprimido, siempre igual en
 * el FAB de WhatsApp (SUP-002) y en "volver arriba". Spring rígido
 * (~180 ms, dentro de la banda 150–250 ms de AGENTS); el layout ya
 * aplica `MotionConfig reducedMotion="user"` para respetar la preferencia
 * del sistema.
 */
export const FAB_MOTION: Pick<
  MotionProps,
  'whileHover' | 'whileTap' | 'transition'
> = {
  whileHover: { scale: 1.08 },
  whileTap: { scale: 0.9 },
  transition: { type: 'spring', stiffness: 420, damping: 24 },
};
