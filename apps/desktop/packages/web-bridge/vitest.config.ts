import { defineConfig } from 'vitest/config'

/**
 * The bridge has no React and no Electron, so it needs none of the Desktop
 * renderer's vitest projects. A dedicated config also makes the package
 * runnable on its own: `npm test` inside this directory works without
 * knowing anything about the app around it.
 *
 * jsdom, not node: `capabilities()` and `createWebBridge()` touch `location`
 * and `window`, and a node environment would make every capability test a
 * stub-fest instead of a real assertion.
 */
export default defineConfig({
  test: {
    name: 'web-bridge',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    globals: false,
    testTimeout: 15_000
  }
})
