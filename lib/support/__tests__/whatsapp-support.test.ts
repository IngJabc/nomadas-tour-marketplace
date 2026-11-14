import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_NUMBER_ENV,
  buildSupportMessage,
  supportMessageCategoryFromPath,
  supportWhatsAppBaseHref,
  supportWhatsAppHref,
  supportWhatsAppNumber,
} from '../whatsapp-support';

/**
 * SUP-001 (número configurable + ausencia) y SUP-003 (plantillas
 * contextuales, identificadores y URL encodeada) del botón de soporte.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SUP-001 · número de soporte configurable', () => {
  it('lee el número de NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER (sin hardcode)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '+58 412 123 4567');

    expect(supportWhatsAppNumber()).toBe('+58 412 123 4567');
    expect(supportWhatsAppBaseHref()).toBe('https://wa.me/584121234567');
  });

  it('sin la env var definida devuelve null (nunca un número propio)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '');

    expect(supportWhatsAppNumber()).toBeNull();
    expect(supportWhatsAppBaseHref()).toBeNull();
  });

  it('valor en blanco no cuenta como configurado', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '   ');

    expect(supportWhatsAppNumber()).toBeNull();
  });

  it('número inválido no genera enlace (nunca un wa.me roto)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, 'no-es-un-telefono');

    expect(supportWhatsAppNumber()).toBe('no-es-un-telefono');
    expect(supportWhatsAppBaseHref()).toBeNull();
    expect(supportWhatsAppHref('general')).toBeNull();
  });

  it('acepta el formato nacional de Venezuela (0412… → 58412…)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');

    expect(supportWhatsAppBaseHref()).toBe('https://wa.me/584121234567');
  });
});

describe('SUP-003 · plantillas por categoría', () => {
  it('cada categoría tiene su propio mensaje base', () => {
    expect(buildSupportMessage('general')).toBe(
      'Hola, necesito ayuda con el Nómadas Marketplace.',
    );
    expect(buildSupportMessage('reservation')).toBe(
      'Hola, necesito ayuda con una reserva en el Nómadas Marketplace.',
    );
    expect(buildSupportMessage('payment')).toBe(
      'Hola, necesito ayuda con un pago en el Nómadas Marketplace.',
    );
    expect(buildSupportMessage('agency')).toBe(
      'Hola, quiero consultar sobre una agencia en el Nómadas Marketplace.',
    );
    expect(buildSupportMessage('suggestion')).toBe(
      'Hola, quiero enviar una sugerencia sobre el Nómadas Marketplace.',
    );
  });

  it('agrega identificadores solo cuando traen valor', () => {
    expect(
      buildSupportMessage('reservation', {
        ticketCode: 'ABCD1234',
        reservationId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toBe(
      'Hola, necesito ayuda con una reserva en el Nómadas Marketplace.\n' +
        'Boleto: ABCD1234\n' +
        'Reserva: 33333333-3333-4333-8333-333333333333',
    );
  });

  it('omite identificadores vacíos, null o undefined (sin líneas fantasma)', () => {
    expect(
      buildSupportMessage('payment', {
        ticketCode: '',
        reservationId: null,
        purchaseId: undefined,
      }),
    ).toBe('Hola, necesito ayuda con un pago en el Nómadas Marketplace.');

    expect(buildSupportMessage('general', null)).toBe(
      'Hola, necesito ayuda con el Nómadas Marketplace.',
    );
    expect(buildSupportMessage('suggestion', {})).toBe(
      'Hola, quiero enviar una sugerencia sobre el Nómadas Marketplace.',
    );
  });

  it('los identificadores van solo en mensajes que los necesitan', () => {
    const message = buildSupportMessage('general', {
      ticketCode: 'ABCD1234',
    });

    // El contexto general no incluye reserva ni boleto si solo pidió ayuda.
    expect(message).toBe('Hola, necesito ayuda con el Nómadas Marketplace.');
  });
});

describe('SUP-003 · enlace wa.me con mensaje URL-encodeado', () => {
  it('codifica espacios, comas y tildes con encodeURIComponent', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');

    expect(supportWhatsAppHref('general')).toBe(
      'https://wa.me/584121234567' +
        '?text=Hola%2C%20necesito%20ayuda%20con%20el%20N%C3%B3madas%20Marketplace.',
    );
  });

  it('el identificador viaja encodeado dentro del texto', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '+584121234567');

    const href = supportWhatsAppHref('reservation', {
      ticketCode: 'ABCD1234',
    });

    expect(href).not.toBeNull();
    expect(href).toContain('https://wa.me/584121234567?text=');
    expect(href).toContain('Boleto%3A%20ABCD1234');
    // El salto de línea entre mensaje e identificador queda encodeado.
    expect(href).toContain('%0A');
  });

  it('sin número configurado ningún enlace se construye (entrada oculta)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '');

    expect(supportWhatsAppHref('general')).toBeNull();
    expect(supportWhatsAppHref('payment', { purchaseId: 'att-1' })).toBeNull();
    expect(supportWhatsAppHref('suggestion')).toBeNull();
  });
});

describe('SUP-003 · categoría derivada de la ruta', () => {
  it('rutas de reserva → reservation', () => {
    expect(supportMessageCategoryFromPath('/reservations/new')).toBe(
      'reservation',
    );
    expect(supportMessageCategoryFromPath('/account/purchases')).toBe(
      'reservation',
    );
    expect(
      supportMessageCategoryFromPath(
        '/account/purchases/33333333-3333-4333-8333-333333333333/ticket',
      ),
    ).toBe('reservation');
  });

  it('ruta de pago → payment', () => {
    expect(
      supportMessageCategoryFromPath(
        '/account/purchases/33333333-3333-4333-8333-333333333333/payment',
      ),
    ).toBe('payment');
    expect(supportMessageCategoryFromPath('/reservations/new/payment')).toBe(
      'payment',
    );
  });

  it('detalle de agencia → agency', () => {
    expect(supportMessageCategoryFromPath('/agencies')).toBe('agency');
    expect(supportMessageCategoryFromPath('/agencies/central')).toBe('agency');
  });

  it('resto (landing, explorar, ayuda…) → general', () => {
    expect(supportMessageCategoryFromPath('/')).toBe('general');
    expect(supportMessageCategoryFromPath('/trips')).toBe('general');
    expect(supportMessageCategoryFromPath('/help')).toBe('general');
    expect(supportMessageCategoryFromPath(null)).toBe('general');
  });
});
