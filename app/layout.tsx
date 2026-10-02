import type { Metadata } from "next";
import { Poppins, Montserrat } from "next/font/google";
import { Navbar } from "@/components/ui/Navbar";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { RootProviders } from "@/components/auth/RootProviders";
import "./globals.css";
import "./design-tokens.css";

const poppins = Poppins({
  // reuse the existing CSS variable name to keep globals.css unchanged
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const montserrat = Montserrat({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["700", "800"],
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
      className={`${poppins.variable} ${montserrat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-brand-surface text-brand-navy">
        <RootProviders>
          <Navbar />
          {children}
          <ToastProvider />
        </RootProviders>
      </body>
    </html>
  );
}
