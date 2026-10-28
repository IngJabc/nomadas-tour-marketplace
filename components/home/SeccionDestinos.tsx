import { Mountain, Waves, TreePalm, Compass } from "lucide-react";
import { TarjetaDestino } from "./TarjetaDestino";
import { Reveal } from "@/components/ui/Reveal";

const DESTINATIONS = [
  {
    nombre: "Mérida",
    descripcion: "Cablecabo, Páramo y calles coloniales a 1.600 m sobre el mar.",
    icono: Mountain,
    gradiente: "bg-gradient-to-br from-[#2A2F3A] via-[#1F232F] to-[#B84E1F]",
    destinoQuery: "Mérida",
  },
  {
    nombre: "Choroní",
    descripcion: "Playas del Caribe y el Parque Nacional Henri Pittier.",
    icono: Waves,
    gradiente: "bg-gradient-to-br from-[#176B62] via-[#1F232F] to-[#B84E1F]",
    destinoQuery: "Choroní",
  },
  {
    nombre: "Canaima",
    descripcion: "Tepuyes, Salto Ángel y lagunas escondidas en la Gran Sabana.",
    icono: Compass,
    gradiente: "bg-gradient-to-br from-[#B84E1F] via-[#1F232F] to-[#14181F]",
    destinoQuery: "Canaima",
  },
  {
    nombre: "Morrocoy",
    descripcion: "Cayos turquesa, manglares y atardeceres sobre el agua.",
    icono: TreePalm,
    gradiente: "bg-gradient-to-br from-[#D4622B] via-[#1F232F] to-[#176B62]",
    destinoQuery: "Morrocoy",
  },
] as const;

/** Sección "Escapadas" del landing: cuadrícula de destinos destacados. */
export function SeccionDestinos() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20">
      <Reveal>
        <div className="max-w-2xl">
          <h2 className="border-l-4 border-brand-cyan pl-3 text-[24px] font-bold sm:text-[28px]">
            Escapadas que empiezan en carretera
          </h2>
          <p className="mt-4 pl-[19px] text-sm leading-relaxed text-brand-muted sm:text-base">
            Rutas frecuentes desde terminal a terminal, con agencias verificadas
            y precios visibles antes de reservar.
          </p>
        </div>
      </Reveal>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {DESTINATIONS.map((destino, index) => (
          <Reveal
            key={destino.nombre}
            delay={index * 0.08}
            hoverLift
            className="h-full"
          >
            <TarjetaDestino {...destino} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}
