import type { Metadata } from "next";
import localFont from "next/font/local";
import { Navbar } from "@/components/ui/Navbar";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { RootProviders } from "@/components/auth/RootProviders";
import { WhatsAppSupportButton } from "@/components/support/WhatsAppSupportButton";
import { BackToTopButton } from "@/components/ui/BackToTopButton";
import { MotionConfig } from "framer-motion";
import "./globals.css";
import "./design-tokens.css";

// Fuentes vendorizadas en app/fonts/ (subset latin, archivos variables de
// Google Fonts). Evita la dependencia de red en dev y build y esquiva el bug
// vercel/next.js#99114 de next/font/google con Turbopack en Next 16.3.x.
// reuse the existing CSS variable name to keep globals.css unchanged
const dmSans = localFont({
  src: "./fonts/dm-sans.woff2",
  weight: "100 1000",
  display: "swap",
  variable: "--font-sans",
});

const elMessiri = localFont({
  src: "./fonts/el-messiri.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--font-heading",
});

export const metadata: Metadata = {
  title: "Nómadas Marketplace | Reserva tu asiento en Venezuela",
  description:
    "Busca viajes, compara precios y reserva tus asientos en tiempo real",
  icons: {
    icon: "/brand/logo-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${dmSans.variable} ${elMessiri.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-brand-surface text-brand-navy">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[10px] focus:bg-brand-cyan focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Saltar al contenido
        </a>
        <RootProviders>
          <MotionConfig reducedMotion="user">
            <Navbar />
            {children}
            <ToastProvider />
            {/* SUP-002: FAB de soporte + "volver arriba" global. */}
            <WhatsAppSupportButton />
            <BackToTopButton />
          </MotionConfig>
        </RootProviders>
      </body>
    </html>
  );
}
