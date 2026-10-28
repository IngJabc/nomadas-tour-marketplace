"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface HeroSectionProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}

const HERO_STAGGER = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
} as const;

const HERO_ITEM = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" as const } },
} as const;

/**
 * Hero de página con fondo oscuro de marca (tinta) y motivo de ruta.
 * Acepta un slot para el widget de búsqueda u otro contenido.
 */
export function HeroSection({ eyebrow, title, subtitle, children }: HeroSectionProps) {
  return (
    <section className="relative overflow-hidden bg-brand-dark text-white">
      {/* Capa de fondo: gradiente cálido + motivo topográfico sutil */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 500px at 85% -10%, rgba(212,98,43,0.35), transparent 60%)," +
            "radial-gradient(700px 420px at 0% 110%, rgba(212,98,43,0.18), transparent 55%)," +
            "linear-gradient(160deg, #14181F 0%, #1F232F 55%, #2A2F3A 100%)",
        }}
      />
      {/* Líneas de ruta decorativas (se dibujan al entrar) */}
      <motion.svg
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.12 }}
        transition={{ duration: 0.8, delay: 0.2 }}
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1200 600"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <motion.path
          d="M-40 480 C 220 430, 320 300, 560 300 S 980 220, 1260 120"
          stroke="#D4622B"
          strokeWidth="2"
          strokeDasharray="6 10"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.6, delay: 0.3, ease: "easeInOut" }}
        />
        <motion.path
          d="M-40 540 C 260 500, 380 380, 620 370 S 1020 300, 1260 210"
          stroke="#D4622B"
          strokeWidth="1.5"
          strokeDasharray="4 12"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.6, delay: 0.55, ease: "easeInOut" }}
        />
        <motion.circle
          cx="560"
          cy="300"
          r="6"
          fill="#D4622B"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.3, delay: 1.2 }}
        />
        <motion.circle
          cx="620"
          cy="370"
          r="4"
          fill="#D4622B"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.3, delay: 1.4 }}
        />
      </motion.svg>

      <div className="relative mx-auto max-w-7xl px-4 pb-24 pt-28 sm:px-6 sm:pb-32 sm:pt-36">
        <motion.div variants={HERO_STAGGER} initial="hidden" animate="show">
          <motion.p
            variants={HERO_ITEM}
            className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E9A57E]"
          >
            {eyebrow}
          </motion.p>
          <motion.h1
            variants={HERO_ITEM}
            className="mt-4 max-w-3xl text-4xl font-bold leading-tight sm:text-5xl lg:text-[56px]"
          >
            {title}
          </motion.h1>
          <motion.p
            variants={HERO_ITEM}
            className="mt-6 max-w-2xl text-base leading-relaxed text-white/75 sm:text-lg"
          >
            {subtitle}
          </motion.p>
          {children ? (
            <motion.div variants={HERO_ITEM} className="mt-10">
              {children}
            </motion.div>
          ) : null}
        </motion.div>
      </div>
    </section>
  );
}
