import { defineConfig } from 'vitest/config';

/**
 * Configuración dedicada para el harness de staging RT-04A.
 *
 * - Entorno `node` (sin jsdom / DOM): el harness usa fetch + supabase-js.
 * - Incluye SOLO `tests/staging/**` — nunca corre en `npm test`, build ni CI.
 * - Timeouts altos: las ventanas del operador (observador) pueden ser largas.
 *
 * Uso: `STAGING_ALLOW=1 npm run test:staging`
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/staging/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
