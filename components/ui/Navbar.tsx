"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useOptionalAuthUser } from "@/components/auth/AuthProvider";

const NAV_LINK_MOTION = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const pathname = usePathname();
  const auth = useOptionalAuthUser();
  const signedIn = !!auth?.user;
  const isCustomer = signedIn && auth?.user?.role === "customer";
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Cerrar el menú móvil al navegar a otra ruta.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Escape cierra el menú abierto.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Un clic fuera del header cierra el menú.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const header = panelRef.current?.closest("header");
      if (target && header && !header.contains(target)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const linkClass =
    "relative pb-1 text-sm font-medium text-brand-navy/75 transition-colors hover:text-brand-navy";
  const mobileLinkClass =
    "block rounded-[10px] px-4 py-3 text-sm font-medium text-brand-navy transition-colors hover:bg-[#f1f5f9]";
  const ctaClass =
    "rounded-full bg-brand-cyan px-5 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue";

  /** Link de escritorio con subrayado elástico compartido (layoutId). */
  function desktopLink(key: string, href: string, label: string) {
    return (
      <Link
        key={key}
        href={href}
        className={linkClass}
        onMouseEnter={() => setHoveredLink(key)}
        onMouseLeave={() => setHoveredLink((current) => (current === key ? null : current))}
      >
        {label}
        {hoveredLink === key && (
          <motion.span
            layoutId="navbar-underline"
            className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-brand-cyan"
            transition={{ duration: 0.18, ease: "easeOut" }}
          />
        )}
      </Link>
    );
  }

  return (
    <motion.header
      initial={{ y: -12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="fixed top-0 z-50 w-full bg-white h-16 border-b border-black/[0.06]"
      style={{
        boxShadow: scrolled ? "0 2px 12px rgba(31,35,47,0.08)" : "none",
      }}
    >
      <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <motion.span
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="inline-flex"
          >
            <Image
              src="/brand/logo-completo.svg"
              alt="Nómadas Marketplace"
              width={160}
              height={36}
              priority
              className="hidden sm:block"
            />
            <Image
              src="/brand/logo-icon.svg"
              alt="Nómadas Marketplace"
              width={32}
              height={32}
              priority
              className="sm:hidden"
            />
          </motion.span>
        </Link>

        {/* Nav escritorio (>= sm) */}
        <nav aria-label="Principal" className="hidden items-center gap-6 sm:flex">
          {desktopLink("explorar", "/trips", "Explorar")}
          {isCustomer && desktopLink("reservas", "/account/purchases", "Mis reservas")}
          {desktopLink("ayuda", "/help", "Ayuda")}
          {signedIn ? (
            <motion.button
              type="button"
              onClick={() => void auth?.signOut()}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.15 }}
              className={ctaClass}
            >
              Cerrar sesión
            </motion.button>
          ) : (
            <>
              {desktopLink("login", "/login", "Iniciar sesión")}
              <motion.span
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
                transition={{ duration: 0.15 }}
                className="inline-flex"
              >
                <Link href="/register" className={ctaClass}>
                  Crear cuenta
                </Link>
              </motion.span>
            </>
          )}
        </nav>

        {/* Menú hamburguesa (solo < sm) */}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="navbar-mobile-menu"
          aria-label={
            menuOpen ? "Cerrar menú de navegación" : "Abrir menú de navegación"
          }
          className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-brand-navy transition-colors hover:bg-[#f1f5f9] sm:hidden"
        >
          <AnimatePresence mode="wait" initial={false}>
            {menuOpen ? (
              <motion.span
                key="close"
                initial={{ rotate: -90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 90, opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="inline-flex"
              >
                <X size={22} strokeWidth={1.75} aria-hidden />
              </motion.span>
            ) : (
              <motion.span
                key="menu"
                initial={{ rotate: 90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: -90, opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="inline-flex"
              >
                <Menu size={22} strokeWidth={1.75} aria-hidden />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Panel del menú móvil: se despliega bajo la barra (altura + opacidad)
          y se cierra al navegar, con Escape o con un clic fuera del header.
          `inert` + `aria-hidden` lo sacen del árbol de accesibilidad y de la
          navegación por Tab cuando está cerrado. */}
      <motion.div
        id="navbar-mobile-menu"
        ref={panelRef}
        aria-hidden={!menuOpen}
        inert={!menuOpen}
        initial={false}
        animate={{
          height: menuOpen ? "auto" : 0,
          opacity: menuOpen ? 1 : 0,
        }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="overflow-hidden border-b border-black/[0.06] bg-white shadow-[0_16px_32px_rgba(31,35,47,0.12)] sm:hidden"
        style={{ pointerEvents: menuOpen ? "auto" : "none" }}
      >
        <motion.nav
          aria-label="Navegación móvil"
          variants={{
            closed: { transition: { staggerChildren: 0, staggerDirection: -1 } },
            open: { transition: { staggerChildren: 0.04, delayChildren: 0.06 } },
          }}
          initial="closed"
          animate={menuOpen ? "open" : "closed"}
          className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-4 sm:px-6"
        >
          <motion.div variants={NAV_LINK_MOTION} transition={{ duration: 0.18 }}>
            <Link href="/trips" className={mobileLinkClass}>
              Explorar
            </Link>
          </motion.div>
          {isCustomer && (
            <motion.div variants={NAV_LINK_MOTION} transition={{ duration: 0.18 }}>
              <Link href="/account/purchases" className={mobileLinkClass}>
                Mis reservas
              </Link>
            </motion.div>
          )}
          <motion.div variants={NAV_LINK_MOTION} transition={{ duration: 0.18 }}>
            <Link href="/help" className={mobileLinkClass}>
              Ayuda
            </Link>
          </motion.div>
          <motion.div
            variants={NAV_LINK_MOTION}
            transition={{ duration: 0.18 }}
            className="mt-2 flex flex-col gap-2 border-t border-black/[0.06] pt-3"
          >
            {signedIn ? (
              <button
                type="button"
                onClick={() => void auth?.signOut()}
                className="rounded-[10px] bg-brand-cyan px-4 py-3 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                Cerrar sesión
              </button>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-center text-sm font-semibold text-brand-navy transition-colors hover:bg-[#e2e8f0]"
                >
                  Iniciar sesión
                </Link>
                <Link
                  href="/register"
                  className="rounded-[10px] bg-brand-cyan px-4 py-3 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                >
                  Crear cuenta
                </Link>
              </>
            )}
          </motion.div>
        </motion.nav>
      </motion.div>
    </motion.header>
  );
}
