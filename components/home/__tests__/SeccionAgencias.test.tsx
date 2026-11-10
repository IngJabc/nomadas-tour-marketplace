import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { publicApi, type PublicAgency } from "@/lib/api";
import { SeccionAgencias } from "../SeccionAgencias";

vi.mock("@/lib/api", () => ({
  publicApi: {
    agencies: vi.fn(),
  },
}));

const mockedAgencies = vi.mocked(publicApi.agencies);

/** Respuesta que nunca se resuelve: mantiene la sección en loading. */
const PENDING_LIST = new Promise<{ agencies: PublicAgency[]; total: number }>(
  () => {},
);

function makeAgency(index: number, overrides: Partial<PublicAgency> = {}): PublicAgency {
  return {
    id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    name: `Agencia ${index}`,
    subdomain: `agencia-${index}`,
    logo_url: null,
    primary_color: "#0F766E",
    secondary_color: null,
    accent_color: null,
    is_featured: false,
    featured_order: 0,
    ratings: {
      agency: { average: null, count: 0 },
      trip: { average: null, count: 0 },
    },
    published_trips_count: 0,
    ...overrides,
  };
}

/** Nombres de las tarjetas renderizadas, en orden del DOM. */
function renderedAgencyNames(): string[] {
  return screen
    .getAllByRole("article")
    .map((card) => card.querySelector("h2")?.textContent ?? "");
}

beforeEach(() => {
  mockedAgencies.mockReset();
});

describe("SeccionAgencias — landing", () => {
  it("pide el lote del landing al endpoint público y muestra las agencias en orden", async () => {
    mockedAgencies.mockResolvedValue({
      agencies: [
        makeAgency(1, { name: "Primera", is_featured: true }),
        makeAgency(2, { name: "Segunda" }),
        makeAgency(3, { name: "Tercera" }),
      ],
      total: 3,
    });

    render(<SeccionAgencias />);
    const cards = await screen.findAllByRole("article");

    expect(mockedAgencies).toHaveBeenCalledWith({ limit: 6 });
    expect(cards).toHaveLength(3);
    // Se conserva el orden del directorio (destacadas primero, sin reordenar).
    expect(renderedAgencyNames()).toEqual(["Primera", "Segunda", "Tercera"]);
    // Cada tarjeta enlaza a su perfil público.
    expect(
      screen.getByRole("link", { name: "Ver perfil de Primera" }),
    ).toHaveAttribute("href", "/agencies/00000001-0000-4000-8000-000000000000");
  });

  it("muestra máximo seis agencias aunque el backend devuelva más", async () => {
    mockedAgencies.mockResolvedValue({
      agencies: Array.from({ length: 9 }, (_, i) => makeAgency(i + 1)),
      total: 9,
    });

    render(<SeccionAgencias />);
    const cards = await screen.findAllByRole("article");

    expect(cards).toHaveLength(6);
  });

  it("muestra el estado de carga con skeleton y sin tarjetas", () => {
    mockedAgencies.mockReturnValue(PENDING_LIST);

    render(<SeccionAgencias />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("muestra el estado vacío con CTA y sin datos ficticios", async () => {
    mockedAgencies.mockResolvedValue({ agencies: [], total: 0 });

    render(<SeccionAgencias />);

    expect(
      await screen.findByText("Aún no hay agencias publicadas"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    // Nunca se completa el vacío con agencias inventadas.
    expect(screen.queryByText(/Bianchi/)).toBeNull();

    const cta = screen.getByRole("link", { name: "Explorar viajes" });
    expect(cta).toHaveAttribute("href", "/trips");
  });

  it("muestra un error público seguro, permite reintentar y no usa fallback ficticio", async () => {
    mockedAgencies.mockRejectedValueOnce(
      new Error("detalle interno sql 500"),
    );
    mockedAgencies.mockResolvedValueOnce({
      agencies: [makeAgency(1, { name: "Recuperada" })],
      total: 1,
    });

    render(<SeccionAgencias />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No pudimos cargar las agencias");
    expect(alert).toHaveTextContent(
      "No pudimos cargar las agencias en este momento. Intenta de nuevo.",
    );
    // Nunca se exponen detalles técnicos internos ni datos ficticios.
    expect(screen.queryByText(/detalle interno sql/)).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /reintentar/i }));

    expect(await screen.findByRole("article")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Recuperada")).toBeInTheDocument();
  });

  it("el CTA de la sección enlaza al directorio /agencies", async () => {
    mockedAgencies.mockResolvedValue({ agencies: [makeAgency(1)], total: 1 });

    render(<SeccionAgencias />);
    await screen.findAllByRole("article");

    const ctas = screen.getAllByRole("link", {
      name: /Ver todas las agencias/,
    });
    expect(ctas).toHaveLength(1);
    expect(ctas[0]).toHaveAttribute("href", "/agencies");
  });
});
