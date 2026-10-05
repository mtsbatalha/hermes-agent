import { defineConfig, mergeConfig } from 'vite'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import baseConfig from '../vite.config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * SPIKE ONLY — Fase 0 harness config.
 *
 * Reuses the Desktop renderer config verbatim and adds a same-origin REST proxy
 * to the Hermes gateway.
 *
 * Only REST is proxied. The gateway WebSocket is NOT: measured against this
 * machine, tunnelling it through the Vite proxy opens the upgrade and then dies
 * with ECONNRESET/1006 (Vite logs `ws proxy socket error`), while the identical
 * handshake straight at the gateway opens, receives `gateway.ready`, and stays
 * up. The bridge therefore dials `ws://127.0.0.1:9119` directly, and this proxy
 * is HTTP-only. Serving the bundle from the backend removes the split entirely.
 */
export default defineConfig(async env => {
  const base = typeof baseConfig === 'function' ? await baseConfig(env) : baseConfig

  return mergeConfig(base as Record<string, unknown>, {
    // The spike MUST be built and previewed, not served by `vite dev`.
    //
    // Root cause measured in this spike: the Desktop boot effect tears the
    // gateway down destructively unless `import.meta.hot` is truthy
    // (use-gateway-boot.ts: `if (import.meta.hot && connectionState === 'open')
    // stash-and-return`, else `setPrimaryGateway(null)`). Under `vite dev`,
    // `import.meta.hot` is TRUE, so every edit tore down the gateway, left the
    // socket orphaned on the wire and reset the store — which presented as
    // "the renderer drops its own gateway socket" and blocked sending. A
    // production build has no `import.meta.hot`, so the destructive path only
    // runs on a real unmount.
    build: {
      outDir: 'spike/dist',
      emptyOutDir: true,
      rollupOptions: { input: path.resolve(__dirname, '../spike.html') }
    },
    preview: {
      host: '127.0.0.1',
      port: 5176,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:9119', changeOrigin: false }
      }
    },
    server: {
      port: 5175,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:9119',
          changeOrigin: false
        }
      }
    }
  })
})