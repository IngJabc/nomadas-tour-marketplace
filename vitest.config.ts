import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test-setup.ts'],
    // Los specs de páginas montan el mapa completo y el equipo suele estar
    // cargado; el default de 5s hace timeouts intermitentes sin ser errores.
    testTimeout: 15000,
    hookTimeout: 15000,
    include: [
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
      'app/**/__tests__/**/*.test.{ts,tsx}',
      'lib/**/__tests__/**/*.test.ts',
      'components/**/__tests__/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
    ],
    env: {
      TZ: 'UTC',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
