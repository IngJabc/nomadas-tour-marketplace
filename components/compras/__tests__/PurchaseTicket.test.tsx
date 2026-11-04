import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PurchaseTicket } from '../PurchaseTicket';
import type { CheckoutTicketView } from '@/lib/api';

vi.mock('react-qr-code', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    QRCode: ({ value, size }: { value: string; size: number }) =>
      createElement('div', {
        'data-testid': 'qr-code',
        'data-value': value,
        'data-size': String(size),
      }),
  };
});

function createTestTicket(overrides: Partial<CheckoutTicketView> = {}): CheckoutTicketView {
  return {
    attempt_id: 'att-123',
    estado: 'reserva_confirmada',
    qr_code: 'NT-CARACAS-TEST1234567890',
    ticket_code: 'TICK1234',
    reservation_id: 'res-123',
    reservation_created_at: '2026-11-01T10:00:00.000Z',
    amount_cents: 5000,
    currency: 'USD',
    paid_at: '2026-11-01T10:05:00.000Z',
    agency: { id: 'ag-1', name: 'Expresos Los Llanos' },
    trip: {
      origin: 'Caracas',
      destination: 'San Cristóbal',
      departure_time: '2026-12-15T14:00:00.000Z',
      status: 'active',
    },
    seats: ['A1', 'A2'],
    passengers: [
      { asiento: 'A1', nombre: 'Carlos Ruiz', boarded: false },
      { asiento: 'A2', nombre: 'María Silva', boarded: false },
    ],
    is_trip_completed: false,
    is_boarding_completed: false,
    ...overrides,
  };
}

describe('PurchaseTicket component', () => {
  it('renders standard active ticket with QR and route information', () => {
    const ticket = createTestTicket();
    render(<PurchaseTicket ticket={ticket} />);

    expect(screen.getByText('Boleto de viaje')).toBeInTheDocument();
    expect(screen.getByText('Presenta este código QR al abordar')).toBeInTheDocument();
    expect(screen.getByText('Caracas → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Expresos Los Llanos')).toBeInTheDocument();
    expect(screen.getByText('Código: TICK1234')).toBeInTheDocument();

    const qr = screen.getByTestId('qr-code');
    expect(qr.getAttribute('data-value')).toBe('NT-CARACAS-TEST1234567890');
    expect(screen.getByTestId('qr-value')).toHaveTextContent('NT-CARACAS-TEST1234567890');
    expect(screen.queryByTestId('trip-completed-banner')).not.toBeInTheDocument();
  });

  it('renders individual passenger boarding statuses when partially boarded', () => {
    const ticket = createTestTicket({
      passengers: [
        { asiento: 'A1', nombre: 'Carlos Ruiz', boarded: true },
        { asiento: 'A2', nombre: 'María Silva', boarded: false },
      ],
      is_boarding_completed: false,
    });
    render(<PurchaseTicket ticket={ticket} />);

    const badges = screen.getAllByTestId('passenger-boarding-status');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('Abordado');
    expect(badges[1]).toHaveTextContent('Por abordar');
    expect(screen.queryByTestId('boarding-completed-badge')).not.toBeInTheDocument();
  });

  it('indicates boarding completed when all passengers are boarded', () => {
    const ticket = createTestTicket({
      passengers: [
        { asiento: 'A1', nombre: 'Carlos Ruiz', boarded: true },
        { asiento: 'A2', nombre: 'María Silva', boarded: true },
      ],
      is_boarding_completed: true,
    });
    render(<PurchaseTicket ticket={ticket} />);

    expect(screen.getAllByText('Abordaje completado')).toHaveLength(2);
    expect(screen.getByTestId('boarding-completed-badge')).toHaveTextContent('Abordaje completado');

    const badges = screen.getAllByTestId('passenger-boarding-status');
    expect(badges.every((b) => b.textContent === 'Abordado')).toBe(true);
  });

  it('renders historical banner and marks ticket invalid for boarding when trip is completed', () => {
    const ticket = createTestTicket({
      is_trip_completed: true,
      is_boarding_completed: true,
      trip: {
        origin: 'Caracas',
        destination: 'San Cristóbal',
        departure_time: '2026-11-01T14:00:00.000Z',
        status: 'completed',
      },
      passengers: [
        { asiento: 'A1', nombre: 'Carlos Ruiz', boarded: true },
        { asiento: 'A2', nombre: 'María Silva', boarded: true },
      ],
    });
    render(<PurchaseTicket ticket={ticket} />);

    expect(screen.getByText('Viaje completado · Comprobante histórico')).toBeInTheDocument();
    expect(screen.getByTestId('trip-completed-banner')).toHaveTextContent(
      'El viaje ya fue completado. Este boleto ya no es válido para abordar.',
    );
    // QR code is preserved for historical integrity
    expect(screen.getByTestId('qr-value')).toHaveTextContent('NT-CARACAS-TEST1234567890');
  });
});
