import { describe, expect, it } from 'vitest';
import { whatsappHref } from '../whatsapp';

describe('whatsappHref (MKT-007.4)', () => {
  it('normaliza un móvil nacional al formato wa.me', () => {
    expect(whatsappHref('04121234567')).toBe('https://wa.me/584121234567');
  });

  it('acepta formato internacional con + y espacios', () => {
    expect(whatsappHref('+58 412 123 4567')).toBe('https://wa.me/584121234567');
  });

  it('acepta el prefijo 00', () => {
    expect(whatsappHref('00584121234567')).toBe('https://wa.me/584121234567');
  });

  it('devuelve null para teléfonos inválidos (nunca inventa enlaces)', () => {
    expect(whatsappHref(null)).toBeNull();
    expect(whatsappHref('')).toBeNull();
    expect(whatsappHref('no-telefono')).toBeNull();
    expect(whatsappHref('123')).toBeNull();
    expect(whatsappHref('0000')).toBeNull();
  });
});
