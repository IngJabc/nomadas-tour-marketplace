import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BusLayout } from '../BusLayout';
import type { PublicTripSeat } from '@/lib/api';

function buildSeats(
  codes: string[],
  statuses: Record<string, PublicTripSeat['status']> = {},
): PublicTripSeat[] {
  return codes.map((seatCode, index) => ({
    id: `seat-${index + 1}`,
    seat_code: seatCode,
    status: statuses[seatCode] ?? 'available',
  }));
}

const KIA_CODES = Array.from({ length: 10 }, (_, index) => `A${index + 1}`);
const BUS_CODES = Array.from({ length: 31 }, (_, index) => `A${index + 1}`);

describe('BusLayout (MKT-003)', () => {
  it('kia renderiza exactamente 10 asientos con puerta, cabina y leyenda encima', () => {
    const { container } = render(
      <BusLayout
        vehicleType="kia"
        seats={buildSeats(KIA_CODES)}
        selectedSeats={[]}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(10);
    expect(
      screen.getByRole('button', { name: 'Asiento A1, disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A10, disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Asiento A11, disponible' }),
    ).not.toBeInTheDocument();

    expect(screen.getByLabelText('Puerta Principal')).toBeInTheDocument();
    expect(screen.getByLabelText('Asiento del guía')).toBeInTheDocument();
    expect(screen.getByLabelText('Conductor')).toBeInTheDocument();

    const legend = screen.getByRole('list', { name: 'Leyenda de asientos' });
    const vehicle = container.querySelector('[data-vehicle]');
    expect(vehicle).not.toBeNull();
    expect(
      legend.compareDocumentPosition(vehicle!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const fondo = screen.getByText('Fondo');
    expect(
      fondo.compareDocumentPosition(vehicle!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const frenteExterno = screen
      .getAllByText('Frente')
      .find((el) => el.closest('[data-vehicle]') === null);
    expect(frenteExterno).toBeDefined();
    expect(
      frenteExterno!.compareDocumentPosition(vehicle!) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it('kia incluye la leyenda completa de estados', () => {
    render(
      <BusLayout
        vehicleType="kia"
        seats={buildSeats(KIA_CODES)}
        selectedSeats={[]}
      />,
    );

    const legend = screen.getByRole('list', { name: 'Leyenda de asientos' });
    for (const label of [
      'Disponible',
      'Seleccionado',
      'Reservado',
      'Bloqueado',
      'Guía',
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
  });

  it('bus renderiza 31 asientos con pasillo central y sin celdas inexistentes', () => {
    const { container } = render(
      <BusLayout
        vehicleType="bus"
        seats={buildSeats(BUS_CODES)}
        selectedSeats={[]}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(31);
    expect(
      screen.getByRole('button', { name: 'Asiento A31, disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A27, disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Asiento A32, disponible' }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-vehicle="bus"]')).not.toBeNull();

    const a25 = screen.getByRole('button', { name: 'Asiento A25, disponible' });
    const row = a25.parentElement as HTMLElement;
    expect(row.children[1]).toBe(a25);
    expect(row.children[2].tagName).toBe('SPAN');
    expect(row.children[2]).toHaveAttribute('aria-hidden', 'true');
    expect(row.children[3]).toBe(
      screen.getByRole('button', { name: 'Asiento A24, disponible' }),
    );
  });

  it('aplica los estados oficiales de asiento y solo los disponibles son interactivos', () => {
    render(
      <BusLayout
        vehicleType="kia"
        seats={buildSeats(
          KIA_CODES.filter((code) => code !== 'A6'),
          { A2: 'reserved', A3: 'locked', A4: 'blocked' },
        )}
        selectedSeats={['A5']}
        onToggleSeat={vi.fn()}
      />,
    );

    const a1 = screen.getByRole('button', { name: 'Asiento A1, disponible' });
    expect(a1).toHaveAttribute('data-state', 'available');
    expect(a1).toHaveStyle({ background: '#00D4FF' });
    expect(a1).not.toBeDisabled();

    const a2 = screen.getByRole('button', { name: 'Asiento A2, reservado' });
    expect(a2).toHaveStyle({ background: '#374151' });
    expect(a2).toBeDisabled();

    const a3 = screen.getByRole('button', { name: 'Asiento A3, bloqueado' });
    expect(a3).toHaveStyle({ background: '#7c3aed' });
    expect(a3).toBeDisabled();

    const a4 = screen.getByRole('button', { name: 'Asiento A4, bloqueado' });
    expect(a4).toHaveStyle({ background: '#7c3aed' });
    expect(a4).toBeDisabled();

    const a5 = screen.getByRole('button', { name: 'Asiento A5, seleccionado' });
    expect(a5).toHaveAttribute('data-state', 'selected');
    expect(a5).toHaveStyle({ background: '#f59e0b' });

    const a6 = screen.getByRole('button', { name: 'Asiento A6, no disponible' });
    expect(a6).toHaveAttribute('data-state', 'missing');
    expect(a6).toHaveStyle({ background: '#e5e7eb' });
    expect(a6).toBeDisabled();
  });

  it('solo dispara onToggleSeat al hacer clic en asientos disponibles', () => {
    const onToggleSeat = vi.fn();
    render(
      <BusLayout
        vehicleType="kia"
        seats={buildSeats(KIA_CODES, { A2: 'reserved' })}
        selectedSeats={[]}
        onToggleSeat={onToggleSeat}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Asiento A1, disponible' }),
    );
    expect(onToggleSeat).toHaveBeenCalledWith('A1');

    fireEvent.click(
      screen.getByRole('button', { name: 'Asiento A2, reservado' }),
    );
    expect(onToggleSeat).toHaveBeenCalledTimes(1);
  });
});
