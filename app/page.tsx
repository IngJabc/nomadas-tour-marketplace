import { HeroSection } from "@/components/home/HeroSection";
import { BuscadorViajes } from "@/components/home/BuscadorViajes";
import { SeccionProximosViajes } from "@/components/home/SeccionProximosViajes";
import { SeccionConfianza } from "@/components/home/SeccionConfianza";
import { SeccionHistoria } from "@/components/home/SeccionHistoria";
import { CTAFinal } from "@/components/home/CTAFinal";

export default function HomePage() {
  return (
    <main id="main" className="flex-1">
      {/* Copy honesto (LND): la compra requiere revisión del comprobante por
          la agencia; no se promete confirmación inmediata. */}
      <HeroSection
        eyebrow="Nómadas Marketplace"
        title="Descubre Venezuela, kilómetro a kilómetro"
        subtitle="Busca viajes, compara agencias verificadas y reserva tu asiento en minutos: la agencia revisa tu comprobante y recibes tu boleto digital."
      >
        <BuscadorViajes />
      </HeroSection>

      <SeccionConfianza />
      <SeccionProximosViajes />
      <SeccionHistoria />
      <CTAFinal />
    </main>
  );
}
