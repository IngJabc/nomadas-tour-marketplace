"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

/** Barra de cierre oscura del landing con el CTA al catálogo. */
export function CTAFinal() {
  return (
    <section className="bg-brand-dark">
      <div className="mx-auto flex max-w-7xl flex-col items-start gap-8 px-4 py-16 sm:px-6 sm:py-20 lg:flex-row lg:items-center lg:justify-between">
        <Reveal>
          <div className="max-w-2xl">
            <h2 className="text-[24px] font-bold text-white sm:text-[32px]">
              Hay un destino esperando al final de la ruta
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/70 sm:text-base">
              Explora el catálogo, compara agencias y reserva tu asiento en pocos
              pasos.
            </p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <motion.span
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="inline-flex"
          >
            <Link
              href="/trips"
              className="inline-flex items-center gap-2 rounded-full bg-brand-cyan px-8 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Explorar viajes
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
            </Link>
          </motion.span>
        </Reveal>
      </div>
    </section>
  );
}
