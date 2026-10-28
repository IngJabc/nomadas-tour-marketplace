"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface PillBadgeProps {
  children: ReactNode;
  className?: string;
}

/**
 * Píldora de estado con entrada elástica (pop-in). Mismo uso que cualquier
 * badge inline: se le pasan las clases de color del sistema y el texto.
 */
export function PillBadge({ children, className }: PillBadgeProps) {
  return (
    <motion.span
      className={className}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
    >
      {children}
    </motion.span>
  );
}
