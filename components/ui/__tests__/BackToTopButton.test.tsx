import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackToTopButton } from '../BackToTopButton';

/**
 * Botón "volver arriba" global (extensión de SUP-002, 2026-11-13):
 * solo aparece en páginas ALTAS (rango scrolleable ≥ 1 viewport, es
 * decir ~2 pantallas de contenido) y solo después de bajar medio
 * viewport; en páginas cortas o arriba del todo no renderiza nada.
 * Mismas animaciones que el FAB de WhatsApp (FAB_MOTION) y posición
 * apilada ARRIBA de él (bottom-24 right-6).
 */

/** Altura de viewport jsdom para los cálculos del componente. */
const VH = window.innerHeight;

const scrollToMock = vi.fn();

beforeEach(() => {
  scrollToMock.mockClear();
  Object.defineProperty(window, 'scrollTo', {
    value: scrollToMock,
    writable: true,
    configurable: true,
  });
  setScrollY(0);
});

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', {
    value,
    writable: true,
    configurable: true,
  });
}

/** Página de `totalViewports` pantallas de alto (clientHeight = 1 vp). */
function stubTallPage(totalViewports: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: VH * totalViewports,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: VH,
    configurable: true,
  });
}

describe('BackToTopButton (global en páginas altas)', () => {
  it('no renderiza en una página corta (sin scroll suficiente)', () => {
    stubTallPage(1); // alto total = 1 viewport: nada que subir.
    setScrollY(500);

    render(<BackToTopButton />);

    expect(
      screen.queryByRole('button', { name: 'Volver arriba' }),
    ).not.toBeInTheDocument();
  });

  it('no renderiza en una página alta si aún no se ha bajado', () => {
    stubTallPage(3);
    setScrollY(0);

    render(<BackToTopButton />);

    expect(
      screen.queryByRole('button', { name: 'Volver arriba' }),
    ).not.toBeInTheDocument();
  });

  it('aparece al bajar medio viewport en una página alta', () => {
    stubTallPage(3);
    setScrollY(VH * 0.5);

    render(<BackToTopButton />);

    expect(
      screen.getByRole('button', { name: 'Volver arriba' }),
    ).toBeInTheDocument();
  });

  it('al hacer click vuelve al inicio con scroll suave', () => {
    stubTallPage(3);
    setScrollY(VH);

    render(<BackToTopButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Volver arriba' }));

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('se oculta de nuevo cuando el usuario vuelve al inicio', () => {
    stubTallPage(3);
    setScrollY(VH);

    render(<BackToTopButton />);
    expect(
      screen.getByRole('button', { name: 'Volver arriba' }),
    ).toBeInTheDocument();

    setScrollY(0);
    fireEvent.scroll(window);

    expect(
      screen.queryByRole('button', { name: 'Volver arriba' }),
    ).not.toBeInTheDocument();
  });

  it('se apila arriba del FAB de WhatsApp (bottom-24, misma columna)', () => {
    stubTallPage(3);
    setScrollY(VH);

    render(<BackToTopButton />);

    const button = screen.getByRole('button', { name: 'Volver arriba' });
    const classes = button.className;
    expect(classes).toContain('fixed');
    expect(classes).toContain('right-6');
    // APILADO ARRIBA del FAB (que vive en bottom-6): nunca se solapan.
    expect(classes).toContain('bottom-24');
    expect(classes).toContain('z-40');
  });
});
