import { describe, expect, it } from 'vitest';
import { compareSeatCodes, sortSeatCodes } from '@/lib/booking/seat-code';

describe('sortSeatCodes (orden natural de asientos)', () => {
  it('ordena A1, A4, A10 y no lexicográfico (A1, A10, A4)', () => {
    expect(sortSeatCodes(['A10', 'A1', 'A4'])).toEqual(['A1', 'A4', 'A10']);
  });

  it('distingue el número: A2 antes que A10', () => {
    expect(sortSeatCodes(['A10', 'A2'])).toEqual(['A2', 'A10']);
    // El orden lexicográfico daría lo contrario.
    expect(['A10', 'A2'].sort()).toEqual(['A10', 'A2']);
  });

  it('ignora el orden de selección sin mutar el arreglo original', () => {
    const original = ['A3', 'A1', 'A2'];
    const ordered = sortSeatCodes(original);

    expect(ordered).toEqual(['A1', 'A2', 'A3']);
    expect(original).toEqual(['A3', 'A1', 'A2']);
  });

  it('respeta el prefijo del asiento', () => {
    expect(sortSeatCodes(['B1', 'A2', 'A10'])).toEqual(['A2', 'A10', 'B1']);
  });

  it('compara código por código', () => {
    expect(compareSeatCodes('A2', 'A10')).toBeLessThan(0);
    expect(compareSeatCodes('A10', 'A2')).toBeGreaterThan(0);
    expect(compareSeatCodes('A1', 'A1')).toBe(0);
  });
});
