import type { Metadata } from "next";
import { DM_Sans, El_Messiri } from "next/font/google";
import { Navbar } from "@/components/ui/Navbar";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { RootProviders } from "@/components/auth/RootProviders";
import { MotionConfig } from "framer-motion";
import "./globals.css";
import "./design-tokens.css";

const dmSans = DM_Sans({
  // reuse the existing CSS variable name to keep globals.css unchanged
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const elMessiri = El_Messiri({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["600", "700"],
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
          </MotionConfig>
        </RootProviders>
      </body>
    </html>
  );
}
