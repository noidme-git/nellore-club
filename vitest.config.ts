import { defineConfig } from 'vitest/config';

// The bracket engine is pure data-in/data-out with no I/O, so it needs no
// browser or workerd environment to test -- plain node is fastest and keeps
// the suite honest about the engine having no hidden dependencies.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'worker/**/*.test.ts'],
    coverage: {
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
