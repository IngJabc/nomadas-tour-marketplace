"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Retraso para escalonar varios Reveal en la misma vista (sobre 0.35s no se nota). */
  delay?: number;
  /** Elevación sutil al pasar el cursor (tarjetas). */
  hoverLift?: boolean;
}

/**
 * Entrada reutilizable con Framer Motion: los hijos aparecen con un
 * fundido + desplazamiento cuando entran en pantalla (una sola vez).
 *
 * Reglas de Motion (AGENTS.md): duración corta, nunca bloquea la
 * interacción y respeta `prefers-reduced-motion` vía MotionConfig
 * (reducedMotion="user" en el layout raíz).
 */
export function Reveal({
  children,
  className,
  delay = 0,
  hoverLift = false,
}: RevealProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      whileHover={hoverLift ? { y: -4 } : undefined}
    >
      {children}
    </motion.div>
  );
}
