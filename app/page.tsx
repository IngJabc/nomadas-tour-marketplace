import { HeroSection } from "@/components/home/HeroSection";
import { BuscadorViajes } from "@/components/home/BuscadorViajes";
import { SeccionDestinos } from "@/components/home/SeccionDestinos";
import { SeccionConfianza } from "@/components/home/SeccionConfianza";
import { SeccionHistoria } from "@/components/home/SeccionHistoria";
import { CTAFinal } from "@/components/home/CTAFinal";

export default function HomePage() {
  return (
    <main id="main" className="flex-1">
      <HeroSection
        eyebrow="Nómadas Marketplace"
        title="Descubre Venezuela, kilómetro a kilómetro"
        subtitle="Busca viajes, compara agencias verificadas y reserva tu asiento en minutos, con confirmación inmediata y boleto digital."
      >
        <BuscadorViajes />
      </HeroSection>

      <SeccionConfianza />
      <SeccionDestinos />
      <SeccionHistoria />
      <CTAFinal />
    </main>
  );
}
