"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface StateIconProps {
  children: ReactNode;
  /** Tono del círculo: info (cyan), neutral, success, warning o error. */
  tone?: "info" | "neutral" | "success" | "warning" | "error";
}

const TONE_CLASSES: Record<NonNullable<StateIconProps["tone"]>, string> = {
  info: "bg-[var(--color-cyan-bg)] text-brand-cyan",
  neutral: "bg-[#f1f5f9] text-brand-navy",
  success: "bg-[#ecfdf5] text-[#059669]",
  warning: "bg-[#fffbeb] text-[#92400e]",
  error: "bg-[#fef2f2] text-[#ef4444]",
};

/**
 * Icono circular de empty state / mensaje con entrada elástica (pop-in).
 * Se usa en estados vacíos, errores y confirmaciones para dar vida a la
 * pantalla sin bloquear la interacción.
 */
export function StateIcon({ children, tone = "info" }: StateIconProps) {
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 22 }}
      className={`flex h-14 w-14 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}
    >
      {children}
    </motion.span>
  );
}
