import { describe, expect, it } from 'vitest';
import {
  contactTelHref,
  contactWhatsAppHref,
  normalizeE164Phone,
  whatsappHref,
} from '../whatsapp';

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

// ── MKT-008: contactos E.164 de agency_contacts ──────────────────────────────

describe('normalizeE164Phone (MKT-008)', () => {
  it('acepta E.164 con prefijos +58, +1 y +44', () => {
    expect(normalizeE164Phone('+584121234567')).toBe('+584121234567');
    expect(normalizeE164Phone('+18095551234')).toBe('+18095551234');
    expect(normalizeE164Phone('+447911123456')).toBe('+447911123456');
  });

  it('quita separadores sin alterar el número', () => {
    expect(normalizeE164Phone('+58 412 123 4567')).toBe('+584121234567');
    expect(normalizeE164Phone('+44-7911-123456')).toBe('+447911123456');
  });

  it('rechaza números sin + o con formato nacional (nunca inventa)', () => {
    expect(normalizeE164Phone('04121234567')).toBeNull();
    expect(normalizeE164Phone('4121234567')).toBeNull();
    expect(normalizeE164Phone('no-telefono')).toBeNull();
    expect(normalizeE164Phone(null)).toBeNull();
    expect(normalizeE164Phone('')).toBeNull();
  });
});

describe('contactWhatsAppHref (MKT-008)', () => {
  it('construye wa.me con el número internacional sin duplicar prefijos', () => {
    expect(contactWhatsAppHref('+584121234567')).toBe('https://wa.me/584121234567');
    expect(contactWhatsAppHref('+18095551234')).toBe('https://wa.me/18095551234');
    expect(contactWhatsAppHref('+447911123456')).toBe('https://wa.me/447911123456');
  });

  it('nunca antepone 58 a un número internacional', () => {
    // Un +1 o +44 mal tratado como "nacional" produciría 581… / 5844….
    expect(contactWhatsAppHref('+18095551234')).not.toContain('581');
    expect(contactWhatsAppHref('+447911123456')).not.toContain('5844');
  });

  it('devuelve null para números no E.164', () => {
    expect(contactWhatsAppHref('04121234567')).toBeNull();
    expect(contactWhatsAppHref('no-telefono')).toBeNull();
    expect(contactWhatsAppHref(null)).toBeNull();
  });
});

describe('contactTelHref (MKT-008)', () => {
  it('construye tel: conservando el + internacional', () => {
    expect(contactTelHref('+584121234567')).toBe('tel:+584121234567');
    expect(contactTelHref('+18095551234')).toBe('tel:+18095551234');
    expect(contactTelHref('+447911123456')).toBe('tel:+447911123456');
  });

  it('devuelve null para números no E.164', () => {
    expect(contactTelHref('04121234567')).toBeNull();
    expect(contactTelHref('no-telefono')).toBeNull();
    expect(contactTelHref(null)).toBeNull();
  });
});
