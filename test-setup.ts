import '@testing-library/jest-dom/vitest';

// jsdom no implementa object URLs (los usa la miniatura del comprobante en
// ProofUploader): sin este stub el guard del componente siempre cae en el
// icono de respaldo y el branch de la imagen quedaría sin cubrir.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:proof-preview';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

// jsdom no implementa IntersectionObserver: lo necesita Framer Motion para
// `whileInView` (Reveal). El stub dispara la intersección de inmediato para
// que los elementos queden visibles en los tests.
if (typeof globalThis.IntersectionObserver !== 'function') {
  class IntersectionObserverStub implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
          } as IntersectionObserverEntry,
        ],
        this,
      );
    }

    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}
