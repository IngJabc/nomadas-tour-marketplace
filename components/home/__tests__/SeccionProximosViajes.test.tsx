import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { publicApi, type PublicTrip } from "@/lib/api";
import { SeccionProximosViajes } from "../SeccionProximosViajes";

vi.mock("@/lib/api", () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
}));

const mockedTrips = vi.mocked(publicApi.trips);

/** Salida a las 11:00 UTC: siempre "futuro" (o pasado) relativo a hoy. */
function isoAt(daysOffset: number): string {
  const date = new Date(Date.now() + daysOffset * 86_400_000);
  date.setUTCHours(11, 0, 0, 0);
  return date.toISOString();
}

let tripSeq = 0;
function makeTrip(overrides: Partial<PublicTrip> = {}): PublicTrip {
  tripSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(tripSeq).padStart(12, "0")}`,
    departure_time: isoAt(10),
    capacity: 31,
    vehicle_type: "bus",
    status: "active",
    route: { origin: "Caracas", destination: "Ruta de prueba" },
    seat_price: 2000,
    available_seats: 12,
    agencies: [{ id: "ag-1", name: "Bianchi travels" }],
    ...overrides,
  };
}

/** Viaje con el campo available_seats ausente por completo (sin la clave). */
function makeTripSinCampoDisponibilidad(): PublicTrip {
  const trip = makeTrip({ capacity: 31 });
  delete trip.available_seats;
  return trip;
}

/** Nombres de ruta accesibles de las tarjetas, en orden del DOM. */
function renderedRouteTitles(): string[] {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent ?? "");
}

beforeEach(() => {
  mockedTrips.mockReset();
  tripSeq = 0;
});

describe("SeccionProximosViajes — LND", () => {
  it("muestra como máximo cuatro viajes, los cuatro más próximos", async () => {
    const sixTrips = Array.from({ length: 6 }, (_, index) =>
      makeTrip({
        departure_time: isoAt(10 + index),
        route: { origin: `Origen ${index + 1}`, destination: `Destino ${index + 1}` },
      }),
    );
    // Respuesta deliberadamente en orden inverso: la sección debe ordenar.
    mockedTrips.mockResolvedValue({ trips: [...sixTrips].reverse() });

    render(<SeccionProximosViajes />);
    const cards = await screen.findAllByRole("article");

    expect(cards).toHaveLength(4);
    expect(renderedRouteTitles()).toEqual([
      "Origen 1 → Destino 1",
      "Origen 2 → Destino 2",
      "Origen 3 → Destino 3",
      "Origen 4 → Destino 4",
    ]);
  });

  it("respeta el orden cronológico de salida ascendente", async () => {
    const late = makeTrip({
      departure_time: isoAt(30),
      route: { origin: "Ciudad tardía", destination: "Destino tardío" },
    });
    const early = makeTrip({
      departure_time: isoAt(5),
      route: { origin: "Ciudad temprana", destination: "Destino temprano" },
    });
    const middle = makeTrip({
      departure_time: isoAt(15),
      route: { origin: "Ciudad media", destination: "Destino medio" },
    });
    mockedTrips.mockResolvedValue({ trips: [late, early, middle] });

    render(<SeccionProximosViajes />);
    await screen.findAllByRole("article");

    expect(renderedRouteTitles()).toEqual([
      "Ciudad temprana → Destino temprano",
      "Ciudad media → Destino medio",
      "Ciudad tardía → Destino tardío",
    ]);
  });

  it("excluye viajes con hora de salida pasada", async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        makeTrip({
          departure_time: isoAt(-5),
          route: { origin: "Pasado origen", destination: "Pasado destino" },
        }),
        makeTrip({
          departure_time: isoAt(20),
          route: { origin: "Futuro origen", destination: "Futuro destino" },
        }),
      ],
    });

    render(<SeccionProximosViajes />);
    await screen.findAllByRole("article");

    expect(
      screen.queryByText("Pasado origen → Pasado destino"),
    ).toBeNull();
    expect(
      screen.getByText("Futuro origen → Futuro destino"),
    ).toBeInTheDocument();
  });

  it("excluye viajes inactivos aunque el endpoint los devuelva", async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        makeTrip({ status: "cancelled" }),
        makeTrip({ status: "completed" }),
        makeTrip({ status: "active" }),
      ],
    });

    render(<SeccionProximosViajes />);
    const cards = await screen.findAllByRole("article");

    expect(cards).toHaveLength(1);
    expect(
      screen.getByText("Caracas → Ruta de prueba"),
    ).toBeInTheDocument();
  });

  it("excluye viajes sin puestos disponibles", async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        makeTrip({ available_seats: 0 }),
        makeTrip({ available_seats: 3 }),
      ],
    });

    render(<SeccionProximosViajes />);
    const cards = await screen.findAllByRole("article");

    expect(cards).toHaveLength(1);
    expect(screen.getByText(/3 asientos disponibles/)).toBeInTheDocument();
  });

  it("muestra el estado de carga con skeletons y sin tarjetas", () => {
    // Promise que nunca se resuelve: la sección queda en carga.
    mockedTrips.mockReturnValue(
      new Promise<{ trips: PublicTrip[] }>(() => {}),
    );

    render(<SeccionProximosViajes />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Cargando viajes…")).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("muestra el estado vacío con CTA al catálogo y sin datos ficticios", async () => {
    mockedTrips.mockResolvedValue({ trips: [] });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText("No hay viajes disponibles por ahora"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    // Nunca se completa el vacío con información inventada (destinos del
    // catálogo editorial del landing, rutas falsas, etc.).
    expect(screen.queryByText(/Mérida/)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();

    const ctas = screen.getAllByRole("link", {
      name: "Explorar todos los viajes",
    });
    expect(ctas.length).toBeGreaterThanOrEqual(1);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute("href", "/trips");
    }
  });

  it("muestra un error público seguro, permite reintentar y no usa fallback ficticio", async () => {
    mockedTrips.mockRejectedValueOnce(new Error("detalle interno sql 500"));
    mockedTrips.mockResolvedValueOnce({
      trips: [makeTrip({ route: { origin: "Recuperado", destination: "Tras reintento" } })],
    });

    render(<SeccionProximosViajes />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No pudimos cargar los viajes");
    expect(alert).toHaveTextContent(
      "No pudimos cargar los viajes en este momento. Intenta de nuevo.",
    );
    // Nunca se exponen detalles técnicos internos ni datos ficticios.
    expect(screen.queryByText(/detalle interno sql/)).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByText(/Mérida/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /reintentar/i }));

    expect(await screen.findByRole("article")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Recuperado → Tras reintento")).toBeInTheDocument();
  });

  it("el CTA de la sección enlaza al catálogo /trips", async () => {
    mockedTrips.mockResolvedValue({ trips: [makeTrip()] });

    render(<SeccionProximosViajes />);
    await screen.findAllByRole("article");

    const ctas = screen.getAllByRole("link", {
      name: "Explorar todos los viajes",
    });
    expect(ctas).toHaveLength(1);
    expect(ctas[0]).toHaveAttribute("href", "/trips");
  });
});

describe("SeccionProximosViajes — disponibilidad (regresión LND-001.1)", () => {
  it("excluye viajes con available_seats: null aunque capacity sea 31", async () => {
    mockedTrips.mockResolvedValue({
      trips: [makeTrip({ available_seats: null })],
    });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText("No hay viajes disponibles por ahora"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    // La capacidad total jamás se muestra como disponibilidad.
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });

  it("excluye viajes con available_seats: undefined aunque capacity sea 31", async () => {
    mockedTrips.mockResolvedValue({
      trips: [makeTrip({ available_seats: undefined })],
    });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText("No hay viajes disponibles por ahora"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });

  it("excluye viajes con el campo available_seats ausente por completo", async () => {
    mockedTrips.mockResolvedValue({
      trips: [makeTripSinCampoDisponibilidad()],
    });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText("No hay viajes disponibles por ahora"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });

  it("excluye viajes con available_seats: 0 aunque capacity sea 31", async () => {
    mockedTrips.mockResolvedValue({
      trips: [makeTrip({ available_seats: 0 })],
    });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText("No hay viajes disponibles por ahora"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });

  it("muestra la disponibilidad positiva con la cifra real, nunca la capacidad", async () => {
    mockedTrips.mockResolvedValue({
      trips: [makeTrip({ available_seats: 7, capacity: 31 })],
    });

    render(<SeccionProximosViajes />);

    expect(
      await screen.findByText(/7 asientos disponibles/),
    ).toBeInTheDocument();
    // Badge superior y línea de detalle usan la cifra REAL (7), no 31.
    expect(screen.getByText("7 asientos")).toBeInTheDocument();
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });

  it("con disponibilidad mixta solo renderiza viajes con cifra real", async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        makeTrip({
          available_seats: null,
          route: { origin: "Sin cifra origen", destination: "Sin cifra destino" },
        }),
        makeTrip({
          available_seats: 5,
          capacity: 31,
          route: { origin: "Con cifra origen", destination: "Con cifra destino" },
        }),
      ],
    });

    render(<SeccionProximosViajes />);

    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(
      screen.getByText("Con cifra origen → Con cifra destino"),
    ).toBeInTheDocument();
    expect(screen.getByText(/5 asientos disponibles/)).toBeInTheDocument();
    expect(
      screen.queryByText("Sin cifra origen → Sin cifra destino"),
    ).toBeNull();
    expect(screen.queryByText(/31 asientos/)).toBeNull();
  });
});
