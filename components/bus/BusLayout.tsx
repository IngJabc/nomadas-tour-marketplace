"use client";

import { useMemo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { PublicTripSeat } from "@/lib/api";
import { rowsFor, type VehicleRow } from "./layouts";

interface BusLayoutProps {
  vehicleType: "bus" | "kia";
  seats: PublicTripSeat[];
  selectedSeats: string[];
  onToggleSeat?: (seatCode: string) => void;
}

interface SeatStyle {
  background: string;
  color: string;
  cursor: string;
  opacity?: number;
  border?: string;
}

const SEAT_STYLES: Record<string, SeatStyle> = {
  available: { background: "#00D4FF", color: "#ffffff", cursor: "pointer" },
  selected: { background: "#f59e0b", color: "#ffffff", cursor: "pointer" },
  reserved: { background: "#374151", color: "#6b7280", cursor: "not-allowed" },
  locked: {
    background: "#7c3aed",
    color: "#ffffff",
    cursor: "not-allowed",
    opacity: 0.7,
  },
  blocked: {
    background: "#7c3aed",
    color: "#ffffff",
    cursor: "not-allowed",
    opacity: 0.7,
  },
  guide: {
    background: "#00000C",
    color: "#ffffff",
    cursor: "not-allowed",
    border: "2px solid #00D4FF",
  },
  missing: { background: "#e5e7eb", color: "#9ca3af", cursor: "not-allowed" },
};

const STATE_LABELS: Record<string, string> = {
  available: "disponible",
  selected: "seleccionado",
  reserved: "reservado",
  locked: "bloqueado",
  blocked: "bloqueado",
  guide: "guía",
  missing: "no disponible",
};

const LEGEND: Array<{ state: string; label: string; style: SeatStyle }> = [
  { state: "available", label: "Disponible", style: SEAT_STYLES.available },
  { state: "selected", label: "Seleccionado", style: SEAT_STYLES.selected },
  { state: "reserved", label: "Reservado", style: SEAT_STYLES.reserved },
  { state: "blocked", label: "Bloqueado", style: SEAT_STYLES.blocked },
  { state: "guide", label: "Guía", style: SEAT_STYLES.guide },
];

const SEAT_CLASSES = "h-9 w-9 sm:h-11 sm:w-11";
const SPAN_CLASSES = "inline-block h-9 w-9 sm:h-11 sm:w-11";
const DOOR_CLASSES = "relative h-9 w-[80px] shrink-0 sm:h-11 sm:w-[96px]";

function seatState(seat: PublicTripSeat | undefined, selected: boolean): string {
  if (!seat) return "missing";
  if (selected) return "selected";
  if (seat.status === "guide") return "guide";
  return seat.status;
}

function SteeringWheelIcon() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="18" cy="18" r="15" stroke="#ffffff" strokeWidth="2.5" />
      <circle cx="18" cy="18" r="5" stroke="#ffffff" strokeWidth="2.5" fill="none" />
      <line x1="18" y1="13" x2="18" y2="3" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="18" y1="13" x2="6" y2="25" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="18" y1="13" x2="30" y2="25" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function DoorBlock() {
  return (
    <div
      className={`${DOOR_CLASSES} flex shrink-0 items-center justify-center rounded-[4px]`}
      style={{ background: "#9ca3af" }}
      aria-label="Puerta Principal"
      data-state="door"
    >
      <span
        className="absolute right-full mr-1.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.06em] text-[#374151]"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
      >
        Puerta Principal
      </span>
    </div>
  );
}

function SeatTile({
  code,
  seat,
  selected,
  onToggle,
}: {
  code: string;
  seat: PublicTripSeat | undefined;
  selected: boolean;
  onToggle?: (seatCode: string) => void;
}) {
  const state = seatState(seat, selected);
  const style = SEAT_STYLES[state] ?? SEAT_STYLES.missing;
  const selectable =
    (state === "available" || state === "selected") && !!onToggle;

  return (
    <button
      type="button"
      data-state={state}
      aria-label={`Asiento ${code}, ${STATE_LABELS[state] ?? state}`}
      disabled={!selectable}
      onClick={() => selectable && onToggle?.(code)}
      className={`${SEAT_CLASSES} inline-flex shrink-0 items-center justify-center rounded-[10px] text-[11px] font-semibold ${
        selectable ? "hover:scale-105 active:scale-95" : ""
      }`}
      style={{
        background: style.background,
        color: style.color,
        cursor: style.cursor,
        opacity: style.opacity,
        border: style.border ?? "none",
        transition:
          "background 180ms ease, opacity 180ms ease, transform 180ms ease",
      }}
    >
      {code}
    </button>
  );
}

function Row({
  row,
  seatMap,
  selectedSeats,
  onToggleSeat,
}: {
  row: VehicleRow;
  seatMap: Map<string, PublicTripSeat>;
  selectedSeats: string[];
  onToggleSeat?: (seatCode: string) => void;
}) {
  const hasDoor = !!row.doorCells;
  const cells = hasDoor ? row.cells.slice(row.doorCells) : row.cells;

  return (
    <div className="flex items-center justify-center gap-2">
      {hasDoor && <DoorBlock />}
      {cells.map((code, index) =>
        code ? (
          <SeatTile
            key={code}
            code={code}
            seat={seatMap.get(code)}
            selected={selectedSeats.includes(code)}
            onToggle={onToggleSeat}
          />
        ) : (
          <span key={`gap-${index}`} className={SPAN_CLASSES} aria-hidden="true" />
        ),
      )}
    </div>
  );
}

export function BusLayout({
  vehicleType,
  seats,
  selectedSeats,
  onToggleSeat,
}: BusLayoutProps) {
  const rows = useMemo(() => rowsFor(vehicleType), [vehicleType]);
  const seatMap = useMemo(
    () => new Map(seats.map((seat) => [seat.seat_code, seat])),
    [seats],
  );

  const rearWheelBottom = vehicleType === "kia" ? 130 : 190;

  return (
    <div className="flex w-full flex-col items-center">
      <ul
        className="mb-4 flex flex-wrap items-center justify-center gap-2"
        aria-label="Leyenda de asientos"
      >
        {LEGEND.map((item) => (
          <li
            key={item.state}
            className="flex items-center gap-1.5 rounded-full bg-[#f1f5f9] px-2.5 py-1 text-[11px] font-semibold text-brand-muted"
          >
            <span
              className="inline-block h-3 w-3 rounded-[4px]"
              style={{
                background: item.style.background,
                opacity: item.style.opacity,
                border: item.style.border ?? "none",
              }}
              aria-hidden="true"
            />
            {item.label}
          </li>
        ))}
      </ul>

      <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-muted">
        <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
        Fondo
      </div>

      <div className="w-full max-w-[280px] sm:max-w-[320px]">
        <div
          className="relative rounded-[40px_40px_24px_24px] border-[3px] border-[#9ca3af] bg-[#d1d5db] p-2 shadow-[0_8px_32px_rgba(0,0,0,0.22)]"
          data-vehicle={vehicleType}
        >
          <div
            className="absolute z-0 h-9 w-5 rounded-md bg-[#1f2937]"
            style={{ left: 14, bottom: -10 }}
            aria-hidden="true"
          />
          <div
            className="absolute z-0 h-9 w-5 rounded-md bg-[#1f2937]"
            style={{ right: 14, bottom: -10 }}
            aria-hidden="true"
          />
          <div
            className="absolute z-0 h-9 w-5 rounded-md bg-[#1f2937]"
            style={{ left: 14, bottom: rearWheelBottom }}
            aria-hidden="true"
          />
          <div
            className="absolute z-0 h-9 w-5 rounded-md bg-[#1f2937]"
            style={{ right: 14, bottom: rearWheelBottom }}
            aria-hidden="true"
          />

          <div className="relative z-10 flex flex-col gap-2 rounded-t-[32px] bg-[#00000C] p-4">
            {rows.map((row, index) => (
              <Row
                key={index}
                row={row}
                seatMap={seatMap}
                selectedSeats={selectedSeats}
                onToggleSeat={onToggleSeat}
              />
            ))}
          </div>

          <div
            className="relative z-10 mt-2 flex h-6 items-center justify-center rounded-[8px]"
            style={{ background: "#6b7280" }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white">
              Frente
            </span>
          </div>

          <div className="relative z-10 mt-2 flex items-center justify-between px-3 pb-1">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-[10px] border-2 border-[#00D4FF]"
              style={{ background: "#166534" }}
              aria-label="Asiento del guía"
            >
              <span className="text-sm font-bold text-white">G</span>
            </div>
            <div
              className="flex h-12 w-12 items-center justify-center rounded-[10px]"
              style={{ background: "#ea580c" }}
              aria-label="Conductor"
            >
              <SteeringWheelIcon />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-muted">
        <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
        Frente
      </div>
    </div>
  );
}
