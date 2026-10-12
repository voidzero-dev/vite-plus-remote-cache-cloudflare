import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // Keep the existing serial entry point for the isolated workerd/D1/R2 suites.
    include: ['test/index.test.ts'],
    environment: 'node',
    // Match node:test's unlimited per-test timeout; CI limits the whole job to 15 minutes.
    testTimeout: 0,
  },
});
