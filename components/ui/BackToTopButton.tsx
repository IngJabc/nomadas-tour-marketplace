'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { FAB_MOTION } from '@/components/ui/fab-motion';

/**
 * Botón "volver arriba" GLOBAL (2026-11-13, extensión de SUP-002).
 *
 * Antes vivía solo en Mis compras; ahora se monta una sola vez en
 * `app/layout.tsx` y aparece en TODA página cuyo alto supere una
 * pantalla completa (rango scrolleable ≥ 1 viewport, es decir ~2
 * pantallas de contenido), únicamente después de haber bajado medio
 * viewport. En páginas cortas o estando arriba del todo no renderiza
 * nada: sin botones inútiles.
 *
 * Posición: esquina inferior derecha, APILADO ARRIBA del FAB de
 * WhatsApp (`bottom-24` vs `bottom-6`, ambos `right-6`) para que nunca
 * se solapen. Mismas animaciones que el FAB vía `FAB_MOTION`.
 */
function computeVisible(): boolean {
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  // "Alto mucho": al menos una pantalla completa scrolleable.
  if (scrollable < window.innerHeight) return false;
  // Solo tras bajar medio viewport (arriba no tiene sentido volver).
  return window.scrollY >= window.innerHeight * 0.5;
}

export function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const update = () => {
      setVisible((prev) => {
        const next = computeVisible();
        return prev === next ? prev : next;
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (!visible) return null;

  return (
    <motion.button
      type="button"
      aria-label="Volver arriba"
      data-testid="back-to-top-button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      {...FAB_MOTION}
      className="fixed bottom-24 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-brand-cyan text-white shadow-lg transition-colors duration-200 hover:bg-brand-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-surface)]"
    >
      <ArrowUp size={20} strokeWidth={1.75} aria-hidden />
    </motion.button>
  );
}
