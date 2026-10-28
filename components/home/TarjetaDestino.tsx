import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

interface TarjetaDestinoProps {
  nombre: string;
  descripcion: string;
  icono: LucideIcon;
  /** Clases de gradiente para la miniatura (sustituye la foto) */
  gradiente: string;
  destinoQuery: string;
}

/**
 * Tarjeta de destino del landing. Es un link a /trips con el destino
 * pre-llenado como filtro inicial.
 */
export function TarjetaDestino({
  nombre,
  descripcion,
  icono: Icono,
  gradiente,
  destinoQuery,
}: TarjetaDestinoProps) {
  return (
    <Link
      href={`/trips?destination=${encodeURIComponent(destinoQuery)}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-brand-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]"
    >
      {/* Miniatura con gradiente temático (sin fotos externas) */}
      <div className={`relative flex h-36 items-center justify-center ${gradiente}`}>
        <Icono size={36} strokeWidth={1.5} className="text-white/90" aria-hidden />
        {/* Línea de ruta decorativa */}
        <svg
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-8 w-full opacity-40"
          viewBox="0 0 300 40"
          fill="none"
          preserveAspectRatio="none"
        >
          <path
            d="M0 32 C 80 20, 160 36, 300 12"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth="2"
            strokeDasharray="4 8"
          />
        </svg>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-bold">{nombre}</h3>
        <p className="mt-1.5 flex-1 text-sm leading-relaxed text-brand-muted">
          {descripcion}
        </p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-cyan transition-transform duration-200 group-hover:translate-x-0.5">
          Explorar viajes
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </span>
      </div>
    </Link>
  );
}
