"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="fixed top-0 z-50 w-full bg-brand-navy h-16"
      style={{
        boxShadow: scrolled ? "0 2px 12px rgba(0,0,0,0.4)" : "none",
      }}
    >
      <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/brand/logo-completo-blanco.svg"
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
        </Link>

        <nav className="flex items-center gap-6">
          <Link
            href="/viajes"
            className="text-sm text-white/75 transition-opacity hover:opacity-100"
          >
            Viajes
          </Link>
          <Link
            href="/login"
            className="rounded-full bg-brand-cyan px-5 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            Iniciar sesión
          </Link>
        </nav>
      </div>
    </header>
  );
}
