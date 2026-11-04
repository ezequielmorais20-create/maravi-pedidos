import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'], // test/unit usa node:test (npm run test:unit)
    setupFiles: ['test/setup.ts'],
    // Os testes de integração compartilham um único banco: execute em série.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
