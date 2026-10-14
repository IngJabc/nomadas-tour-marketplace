import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Marketplace: rutas de cliente autenticado
const protectedPaths = ['/cuenta', '/reservas'];
const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password', '/viajes', '/agencias', '/'];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // `/reservas/nueva` es el wizard de reserva y es PÚBLICO: funciona como
  // guest (locks por cookie HttpOnly, claim al volver del login) y exige
  // sesión recién en el paso de pago con el gate dentro de la propia página.
  // Protegerlo aquí cortaba el flujo completo hacia el wizard.
  const isNewReservationWizard =
    pathname === '/reservas/nueva' || pathname.startsWith('/reservas/nueva/');
  const isProtected =
    protectedPaths.some((path) => pathname.startsWith(path)) &&
    !isNewReservationWizard;
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    const originalPath = pathname + request.nextUrl.search;
    url.pathname = '/login';
    url.searchParams.set('redirect', originalPath);
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
