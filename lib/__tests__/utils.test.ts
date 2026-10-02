import { describe, it, expect } from 'vitest';
import { formatDateTime, cn, generateQRCode } from '@/lib/utils';

describe('formatDateTime', () => {
  it('formats ISO date string correctly', () => {
    // BUSINESS_TIMEZONE = America/Caracas (UTC-4); hour12 en-US
    const result = formatDateTime('2026-06-19T14:30:00Z');
    expect(result).toBe('19/06/2026 \u00B7 10:30 AM');
  });

  it('handles different timezone offset', () => {
    const result = formatDateTime('2026-01-05T08:15:00-03:00');
    expect(result).toContain('05/01/2026');
  });
});

describe('cn', () => {
  it('joins truthy class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('filters out falsy values', () => {
    expect(cn('foo', false, undefined, null, 'bar')).toBe('foo bar');
  });

  it('returns empty string for no truthy values', () => {
    expect(cn(false, undefined, null)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(cn()).toBe('');
  });
});

describe('generateQRCode', () => {
  it('generates a string containing CAMPING- prefix', () => {
    const code = generateQRCode();
    expect(code).toMatch(/^CAMPING-/);
  });

  it('includes a timestamp component', () => {
    const code = generateQRCode();
    const parts = code.split('-');
    expect(parts.length).toBe(3);
    expect(parts[1]).toMatch(/^\d+$/);
  });

  it('generates unique codes on successive calls', () => {
    const code1 = generateQRCode();
    const code2 = generateQRCode();
    expect(code1).not.toBe(code2);
  });
});
