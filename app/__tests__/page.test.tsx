import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import HomePage from "../page";

// BuscadorViajes (hijo del hero) usa el router de la app.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// La sección LND hace fetch real: aquí solo se verifica que la landing la
// monta; su comportamiento se cubre en components/home/__tests__.
vi.mock("@/components/home/SeccionProximosViajes", () => ({
  SeccionProximosViajes: () => <div data-testid="seccion-proximos-viajes" />,
}));

// Igual que la anterior: la sección de agencias hace fetch real.
vi.mock("@/components/home/SeccionAgencias", () => ({
  SeccionAgencias: () => <div data-testid="seccion-agencias" />,
}));

describe("Landing (/) — LND", () => {
  it("monta la sección de próximas salidas", () => {
    render(<HomePage />);
    expect(screen.getByTestId("seccion-proximos-viajes")).toBeInTheDocument();
  });

  it("monta la sección de agencias después de la de viajes", () => {
    render(<HomePage />);
    expect(screen.getByTestId("seccion-agencias")).toBeInTheDocument();

    // Orden explícito: agencias inmediatamente después de los viajes.
    const viajes = screen.getByTestId("seccion-proximos-viajes");
    const agencias = screen.getByTestId("seccion-agencias");
    expect(
      viajes.compareDocumentPosition(agencias) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("el hero no promete confirmación inmediata (la compra requiere revisión del comprobante)", () => {
    render(<HomePage />);
    expect(screen.queryByText(/confirmación inmediata/i)).toBeNull();
    expect(
      screen.getByText(/la agencia revisa tu comprobante y recibes tu boleto digital/i),
    ).toBeInTheDocument();
  });

  it("el hero no recorta el popover del DatePicker del buscador", () => {
    render(<HomePage />);
    const hero = screen.getByTestId("hero-section");

    // Regresión: `overflow-hidden` en el hero cortaba el calendario del
    // buscador (popover absoluto que se desborda por debajo del hero).
    expect(hero).not.toHaveClass("overflow-hidden");

    // Y debe pintar por encima de las secciones siguientes (SeccionConfianza…),
    // si no, quedaría tapado aunque no esté recortado.
    expect(hero).toHaveClass("z-10");
  });
});
