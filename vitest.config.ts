import { defineConfig } from 'vitest/config';

// Tests run in Node without the app's Vite plugins: the engine is pure and needs none.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
});
