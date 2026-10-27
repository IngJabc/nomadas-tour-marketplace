import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/agency-assets/**',
      },
    ],
  },
  // Las rutas del marketplace pasaron a inglés (patrón de nomadas-tour).
  // Estos redirects permanentes (308) mantienen vivos los enlaces viejos
  // que ya estén circulando o guardados en marcadores: se evalúan ANTES
  // que el middleware y preservan los query params (p. ej. ?trip=...).
  async redirects() {
    return [
      {
        source: '/cuenta/compras/:attemptId/boleto',
        destination: '/account/purchases/:attemptId/ticket',
        permanent: true,
      },
      {
        source: '/cuenta/compras/:attemptId/pago',
        destination: '/account/purchases/:attemptId/payment',
        permanent: true,
      },
      {
        source: '/cuenta/compras',
        destination: '/account/purchases',
        permanent: true,
      },
      {
        source: '/reservas/nueva',
        destination: '/reservations/new',
        permanent: true,
      },
      {
        source: '/viajes',
        destination: '/trips',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
