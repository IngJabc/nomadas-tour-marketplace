"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { authApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { establishSupabaseSession } from "@/lib/auth/session";
import { useOptionalAuthUser } from "@/components/auth/AuthProvider";

/** Solo rutas internas: evita open redirect con el parámetro `redirect`. */
function safeRedirect(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/viajes";
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useOptionalAuthUser();

  const redirect = safeRedirect(searchParams.get("redirect"));
  const loginHref = searchParams.get("redirect")
    ? `/login?redirect=${encodeURIComponent(redirect)}`
    : "/login";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await authApi.register({
        email: email.trim(),
        password,
      });
      if (!session.token || !session.refresh_token) {
        // Sin confirmación de correo no hay sesión que establecer.
        setNotice(
          "Tu cuenta fue creada. Revisa tu correo para confirmarla y luego inicia sesión.",
        );
        return;
      }
      await establishSupabaseSession(session.token, session.refresh_token);
      await auth?.refresh();
      router.push(redirect);
    } catch (e) {
      setError(
        getApiErrorMessage(e, "No pudimos crear tu cuenta. Intenta de nuevo."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex flex-1 items-center justify-center px-8 pt-24 pb-16">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="border-l-4 border-brand-cyan pl-3">
          <h1 className="text-2xl font-bold">Crear cuenta</h1>
          <p className="mt-1 text-sm text-brand-muted">
            Regístrate para reservar y guardar tus viajes.
          </p>
        </div>

        <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-xs font-medium uppercase text-brand-muted"
            >
              Correo electrónico
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
              placeholder="tu@correo.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-xs font-medium uppercase text-brand-muted"
            >
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
              placeholder="Mínimo 6 caracteres"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-[10px] bg-[#fef2f2] px-4 py-3 text-sm text-[#ef4444]"
            >
              {error}
            </p>
          )}

          {notice && (
            <p
              role="status"
              className="rounded-[10px] bg-[#ecfdf5] px-4 py-3 text-sm text-[#059669]"
            >
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className={`flex w-full items-center justify-center gap-2 rounded-[10px] px-5 py-3 text-sm font-semibold text-white transition-colors ${
              busy
                ? "cursor-not-allowed bg-brand-cyan opacity-40"
                : "bg-brand-cyan hover:bg-brand-blue"
            }`}
          >
            {busy && (
              <LoaderCircle
                size={16}
                strokeWidth={1.75}
                className="animate-spin"
                aria-hidden="true"
              />
            )}
            {busy ? "Creando cuenta…" : "Crear cuenta"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-brand-muted">
          ¿Ya tienes cuenta?{" "}
          <Link
            href={loginHref}
            className="font-semibold text-brand-blue hover:underline"
          >
            Inicia sesión
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
