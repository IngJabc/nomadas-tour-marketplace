import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgencyPublicContact } from '@/lib/api';
import { AgencyContactLinks } from '../AgencyContactLinks';

function contact(
  overrides: Partial<AgencyPublicContact> = {},
): AgencyPublicContact {
  return {
    id: 'c-1',
    label: 'Ventas',
    phone: '+584121234567',
    channel: 'whatsapp',
    ...overrides,
  };
}

describe('AgencyContactLinks (MKT-008)', () => {
  it('renderiza varios contactos con su etiqueta y número', () => {
    render(
      <AgencyContactLinks
        contacts={[
          contact(),
          contact({
            id: 'c-2',
            label: 'Emergencias',
            phone: '+18095551234',
            channel: 'call',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Ventas:')).toBeInTheDocument();
    expect(screen.getByText('+584121234567')).toBeInTheDocument();
    expect(screen.getByText('Emergencias:')).toBeInTheDocument();
    expect(screen.getByText('+18095551234')).toBeInTheDocument();
  });

  it('construye un enlace tel: correcto para channel=call', () => {
    render(
      <AgencyContactLinks
        contacts={[
          contact({ id: 'c-3', label: 'Línea fija', phone: '+447911123456', channel: 'call' }),
        ]}
      />,
    );

    const link = screen.getByRole('link', { name: /Línea fija/ });
    expect(link).toHaveAttribute('href', 'tel:+447911123456');
    // tel: no abre pestaña nueva.
    expect(link).not.toHaveAttribute('target');
  });

  it('construye enlaces wa.me correctos para +58, +1 y +44 sin duplicar prefijos', () => {
    render(
      <AgencyContactLinks
        contacts={[
          contact({ id: 'c-58', label: 'Local', phone: '+584121234567', channel: 'whatsapp' }),
          contact({ id: 'c-1', label: 'US', phone: '+18095551234', channel: 'whatsapp' }),
          contact({ id: 'c-44', label: 'UK', phone: '+447911123456', channel: 'whatsapp' }),
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: /Local/ })).toHaveAttribute(
      'href',
      'https://wa.me/584121234567',
    );
    expect(screen.getByRole('link', { name: /US/ })).toHaveAttribute(
      'href',
      'https://wa.me/18095551234',
    );
    expect(screen.getByRole('link', { name: /UK/ })).toHaveAttribute(
      'href',
      'https://wa.me/447911123456',
    );
  });

  it('los enlaces de WhatsApp abren en nueva pestaña de forma segura', () => {
    render(<AgencyContactLinks contacts={[contact()]} />);

    const link = screen.getByRole('link', { name: /Ventas/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('un número inválido se muestra como texto y nunca inventa un enlace', () => {
    render(
      <AgencyContactLinks
        contacts={[contact({ phone: 'no-telefono', channel: 'call' })]}
      />,
    );

    expect(screen.getByText('no-telefono')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('sin contactos no renderiza nada', () => {
    const { container } = render(<AgencyContactLinks contacts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
