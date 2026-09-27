import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**', 'src/stores/memory/**'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'concurrency', include: ['tests/concurrency/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'adapter', include: ['tests/adapter/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'nestjs',
          include: ['tests/nestjs/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
    ],
  },
});
