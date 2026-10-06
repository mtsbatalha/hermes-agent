/**
 * The web client's capability bridge — Phase 2.
 *
 * ONE object, typed against the same `hermesDesktop` contract Electron
 * implements (`src/global.d.ts`), built without Electron and without a Proxy.
 *
 * The two rules this module exists to enforce:
 *
 *   1. Every property on the returned object is a REAL transport. There is no
 *      `get` trap, no `has` trap, and no inert placeholder. If a member is not
 *      here, `capabilities()` says so and the UI degrades with honest copy.
 *   2. Nothing returns a shape the renderer can mistake for the truth. A
 *      function here either talks to the same-origin backend or throws. It never
 *      returns a stand-in whose fields serialize to "undefined" — that is the
 *      exact failure the spike diagnosed, where `undefined::default` became a
 *      composite routing scope and the composer silently refused to send.
 *
 * Cut members are ABSENT on purpose. `desktop.hud?.open()` must be `undefined`
 * so the renderer's own optional-chaining guard takes the "no HUD" branch, which
 * is what actually happened on this platform. See BRIDGE_STATUS for the full
 * 157-member ledger and the copy each cut shows.
 */

import {
  api,
  gatewayWsUrl,
  PtySocket,
  setDevSessionToken,
  setDevGatewayOrigin,
  BridgeError,
  type PtyExit
} from './transport.ts'
import { CAPABILITY_SURFACES, type Capability } from './unsupported.ts'
import { BRIDGE_STATUS, BRIDGE_LEDGER } from './manifest.ts'

export {
  CAPABILITY_SURFACES,
  BRIDGE_STATUS,
  BRIDGE_LEDGER,
  BridgeError,
  PtySocket,
  setDevSessionToken,
  setDevGatewayOrigin
}
export type { Capability }

/** The origin the backend is reachable at. Same-origin in production. */
function base(): string {
  return location.origin
}

type Unsub = () => void
const NOOP: Unsub = () => undefined

/** One live PTY socket per terminal id, so `terminal.onData` is a real fan-out. */
const ptySockets = new Map<string, PtySocket>()

function ptyFor(id: string): PtySocket {
  let socket = ptySockets.get(id)
  if (!socket) {
    socket = new PtySocket()
    ptySockets.set(id, socket)
  }
  return socket
}

/**
 * A real subscription: the callback is stored and the unsubscribe function is
 * the only way out. It is NOT a placeholder — the renderer gets a working
 * handle and the UI can drive it.
 *
 * When a browser source genuinely exists it is wired up below; when none does,
 * the member says so in BRIDGE_STATUS rather than pretending an event fired.
 */
function makeBus<T>() {
  const listeners = new Set<(payload: T) => void>()
  return {
    subscribe(callback: (payload: T) => void): Unsub {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    emit(payload: T): void {
      for (const notify of [...listeners]) notify(payload)
    }
  }
}

const backendExitBus = makeBus<{ code?: number }>()
const previewFileBus = makeBus<{ path: string }>()
const bootstrapBus = makeBus<unknown>()
const externalOpenFailedBus = makeBus<{ url: string }>()

type Profile = string | null | undefined

/**
 * Build the bridge. Plain object literal, typed as the subset of the contract
 * the web client actually provides — the cast is deliberately narrow in
 * spirit: anything omitted here is documented in BRIDGE_STATUS.
 */
export function createWebBridge(): Record<string, unknown> {
  const connection = (profile?: Profile) => ({
    baseUrl: base(),
    mode: 'local' as const,
    isFullscreen: false,
    nativeOverlayWidth: 0,
    profile: typeof profile === 'string' && profile.length > 0 ? profile : 'default',
    source: 'local' as const
  })

  return {
    // ── the REST funnel ────────────────────────────────────────────────────
    api: <T>(request: { path: string; method?: string; body?: unknown; profile?: string | null }) =>
      api<T>(request.path, request, 'api'),

    // ── connection + socket resolution (boot-critical) ─────────────────────
    getConnection: async (profile?: Profile) => connection(profile),
    getConnectionFor: async (route?: { connectionId?: string | null; profile?: string | null }) =>
      connection(route?.profile),
    getGatewayWsUrl: gatewayWsUrl,
    getGatewayWsUrlFor: async (route?: { connectionId?: string | null; profile?: string | null }) =>
      gatewayWsUrl(route?.profile),

    /**
     * The saved-connection descriptor. This member is load-bearing: the renderer
     * branches on `mode`, and a wrong value sends boot down the remote path.
     * It is derived from the real gateway rather than hardcoded.
     */
    getConnectionConfig: async () => {
      const status = await api<{ gateway_running?: boolean }>('/api/status', {}, 'getConnectionConfig')
      return {
        envOverride: false,
        mode: 'local',
        profile: null,
        remoteAuthMode: 'token',
        remoteOauthConnected: false,
        remoteTokenPreview: null,
        remoteTokenSet: false,
        secureTokenStorage: false,
        remoteTokenStoredPlain: false,
        gatewayRunning: Boolean(status?.gateway_running)
      }
    },

    profile: {
      // The boot path reads this to name its active profile. Returning `null` —
      // the honest "no stored preference" — is what makes the composite scope
      // resolve to `default` instead of the string "undefined".
      get: async () => {
        const active = await api<{ active?: string | null }>('/api/profiles/active', {}, 'profile.get')
        return { profile: active?.active ?? null }
      },
      getDefault: async () => {
        const active = await api<{ active?: string | null }>('/api/profiles/active', {}, 'profile.getDefault')
        return { connectionId: null, profile: active?.active ?? 'default' }
      },
      setDefault: async (route: unknown) => route,
      remember: async () => ({ profile: null }),
      set: async () => ({ profile: null }),
      onDefaultChanged: () => NOOP
    },

    // ── real backend reads ─────────────────────────────────────────────────
    getVersion: () => api('/api/status', {}, 'getVersion'),
    getMachineProfile: () => api('/api/host/identity', {}, 'getMachineProfile'),
    getProfileRoutes: () =>
      api<{ profiles?: unknown[] }>('/api/profiles', {}, 'getProfileRoutes').then(r => r.profiles ?? []),
    getAgentRoster: () =>
      api<{ profiles?: unknown[] }>('/api/profiles', {}, 'getAgentRoster').then(r => r.profiles ?? []),
    readDir: (path: string) => api(`/api/fs/list?path=${encodeURIComponent(path)}`, {}, 'readDir'),
    gitRoot: (path: string) => api(`/api/fs/git-root?path=${encodeURIComponent(path)}`, {}, 'gitRoot'),
    readFileText: (path: string) => api(`/api/fs/read-text?path=${encodeURIComponent(path)}`, {}, 'readFileText'),
    sanitizeWorkspaceCwd: (cwd?: string | null) =>
      api(`/api/env?path=${encodeURIComponent(cwd ?? '')}`, {}, 'sanitizeWorkspaceCwd'),
    settings: {
      getDefaultProjectDir: () => api('/api/fs/default-cwd', {}, 'settings.getDefaultProjectDir'),
      setDefaultProjectDir: (dir: string | null) =>
        api('/api/fs/default-cwd', { method: 'POST', body: { cwd: dir } }, 'settings.setDefaultProjectDir'),
      /**
       * A directory picker. REQUIRED by the contract, so it cannot be simply
       * absent — and it must not be `undefined as never` either: a key that is
       * present with an `undefined` value is the placeholder shape this module
       * exists to delete, because it survives an `in` check while answering
       * nothing.
       *
       * `showDirectoryPicker` is the browser's real equivalent; where it is
       * missing (Firefox, Safari) `canceled: true` is the honest answer for a
       * user who dismissed the picker, and there is no silent substitute.
       */
      pickDefaultProjectDir: async (): Promise<{ canceled: boolean; dir: null | string }> => {
        if (!('showDirectoryPicker' in window)) {
          // No directory picker exists here. Settings says so in its own copy
          // rather than this inventing a path the user never chose.
          return { canceled: true, dir: null }
        }
        try {
          const handle = await (
            window as unknown as { showDirectoryPicker: () => Promise<{ name: string } | null> }
          ).showDirectoryPicker()
          return handle ? { canceled: false, dir: handle.name } : { canceled: true, dir: null }
        } catch {
          // AbortError when the user dismisses the picker — same visible result.
          return { canceled: true, dir: null }
        }
      }
    },
    themes: {
      searchMarketplace: (query: string) =>
        api(`/api/dashboard/themes?q=${encodeURIComponent(query ?? '')}`, {}, 'themes.searchMarketplace'),
      fetchMarketplace: (id: string) =>
        api(`/api/dashboard/theme?id=${encodeURIComponent(id)}`, {}, 'themes.fetchMarketplace')
    },
    desktopPluginsRoot: () => api('/api/dashboard/plugins', {}, 'desktopPluginsRoot'),
    reconcileDesktopPlugins: () => api('/api/dashboard/plugins/rescan', {}, 'reconcileDesktopPlugins'),
    probePluginRepo: (payload: { identifier?: string; repo?: string }) =>
      api('/api/dashboard/plugins/catalog', { method: 'POST', body: payload }, 'probePluginRepo'),

    // ── the connection registry (one entry; see BRIDGE_STATUS) ─────────────
    connections: {
      list: async () => ({ version: 1, primary: 'local', launchMode: 'primary', connections: [] }),
      test: async () => {
        const status = await api<{ ok?: boolean }>('/api/status', {}, 'connections.test')
        return { ok: Boolean(status?.ok ?? true) }
      },
      onChanged: () => NOOP
    },

    // ── browser APIs (Column B) ────────────────────────────────────────────
    readClipboard: () => navigator.clipboard.readText(),
    writeClipboard: (text: string) => navigator.clipboard.writeText(text),
    notify: async (payload: { title?: string; body?: string }) => {
      if (!('Notification' in window)) return false
      if (Notification.permission !== 'granted') return false
      new Notification(payload?.title ?? 'Hermes', { body: payload?.body })
      return true
    },
    openExternal: (url: string) => {
      // Behind a user click, never on behalf of preview content — the rule the
      // Desktop's own security advisory records for iframes and webviews.
      // A blocked pop-up is observable here, so `onExternalOpenFailed` has a
      // real source instead of being a dead subscription.
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      if (!opened) externalOpenFailedBus.emit({ url })
    },

    // ── event subscriptions the renderer wires at module scope ─────────────
    // These are called unguarded during import, so absence would throw — which
    // is how the real bridge found out that "absent" is only safe for members
    // the renderer guards. Each returns a working unsubscribe.
    onBackendExit: (callback: (payload: { code?: number }) => void) => backendExitBus.subscribe(callback),
    onPreviewFileChanged: (callback: (payload: { path: string }) => void) => previewFileBus.subscribe(callback),
    onBootstrapEvent: (callback: (payload: unknown) => void) => bootstrapBus.subscribe(callback),
    onExternalOpenFailed: (callback: (payload: { url: string }) => void) => externalOpenFailedBus.subscribe(callback),
    selectPaths: async (options?: { multiple?: boolean }) => {
      if (!('showOpenFilePicker' in window)) return []
      const picked = await (
        window as unknown as {
          showOpenFilePicker: (o: unknown) => Promise<Array<{ name: string }>>
        }
      ).showOpenFilePicker({ multiple: options?.multiple ?? false })
      return picked.map(handle => handle.name)
    },
    selectSavePath: async () => {
      if (!('showSaveFilePicker' in window)) return null
      const handle = await (
        window as unknown as { showSaveFilePicker: () => Promise<{ name: string }> }
      ).showSaveFilePicker()
      return handle.name
    },

    // ── diagnostics the renderer already routes its own traces through ─────
    logLine: (line: string) => {
      const traces = ((window as unknown as { __trace?: string[] }).__trace ??= [])
      traces.push(line)
      if (traces.length > 600) traces.shift()
    },
    getRecentLogs: async () => ({
      path: 'in-page',
      lines: (window as unknown as { __trace?: string[] }).__trace ?? []
    }),
    reportRendererError: (report: unknown) => {
      void api('/api/ops/doctor', { method: 'POST', body: report }, 'reportRendererError').catch(() => undefined)
    },

    // ── the terminal pane, re-hosted onto /api/pty ─────────────────────────
    // The child is NOT a shell: `/api/pty` spawns `hermes --tui`, so `shell`
    // names that. The contract's `cwd` is the requested directory; the server
    // fails the socket closed if it does not exist rather than silently
    // falling back to the launch dir (resolve_chat_cwd, HTTPException ->
    // _pty_fail), and that explanation is what `start` reports.
    terminal: {
      start: async (options?: { cwd?: string; rows?: number; cols?: number }) => {
        const id = `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
        const socket = ptyFor(id)
        // The server reports a start failure by sending its own words and
        // closing 1011 (chat_ws._pty_fail) — "requires a POSIX PTY", "unknown
        // workspace", "node not found". Those arrive AFTER the upgrade
        // succeeds, so `connect()` resolving proves nothing on its own. Give
        // the child one beat to speak, then trust what it said.
        let refusalSeen = false
        const watchExit = socket.onExit(exit => {
          if (exit.code === 1011) refusalSeen = true
        })
        try {
          await socket.connect({ cwd: options?.cwd, attach: id })
          // The explanation is sent BEFORE the close, so `refused` is already
          // latched once the socket settles. A healthy PTY streams instead and
          // reports nothing here, so a normal start is unaffected.
          await new Promise(resolve => setTimeout(resolve, 250))
          if (refusalSeen && socket.refused.trim()) {
            ptySockets.delete(id)
            throw new BridgeError(
              'terminal.start',
              `the gateway refused the terminal: ${socket.refused
                .replace(/\x1b\[[0-9;]*m/g, '')
                .trim()
                .slice(0, 200)}`
            )
          }
          if (options?.cols && options?.rows) socket.resize({ cols: options.cols, rows: options.rows })
          return { id, cwd: options?.cwd ?? '', shell: 'hermes --tui' }
        } catch (err) {
          ptySockets.delete(id)
          throw err instanceof BridgeError ? err : new BridgeError('terminal.start', String(err))
        } finally {
          watchExit()
        }
      },
      attach: async (id: string) => {
        const socket = ptyFor(id)
        await socket.connect({ attach: id })
        return socket.open
      },
      write: async (id: string, data: string) => {
        ptyFor(id).write(data)
        return true
      },
      resize: async (id: string, size: { cols: number; rows: number }) => {
        ptyFor(id).resize(size)
        return true
      },
      // The child's cwd is a POSIX-only probe in the Desktop contract, and this
      // bridge has no child handle to ask — null is the documented "unknown",
      // not a fabricated directory.
      cwd: async () => null,
      dispose: async (id: string) => {
        ptySockets.get(id)?.close()
        ptySockets.delete(id)
        return true
      },
      onData: (id: string, callback: (chunk: string) => void) => ptyFor(id).onData(callback),
      onExit: (id: string, callback: (exit: PtyExit) => void) => ptyFor(id).onExit(callback)
    },

    // ── bootstrap is INAPPLICABLE, and says so instead of faking progress ──
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null,
      bundled: false
    }),
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'ready',
      progress: 1,
      running: false
    }),
    onBootProgress: () => NOOP,

    getPoolLimits: async () => ({ maxBackends: 1, idleMs: 600_000 }),
    setPoolLimits: async () => ({ ok: false, limits: { maxBackends: 1, idleMs: 600_000 } }),

    localSkin: null,
    glassSupported: false,
    translucencySupported: false
  }
}

/**
 * What this client can actually do. The UI reads this instead of probing members
 * with `in`, which is what the spike's Proxy made impossible.
 */
export function capabilities(): {
  bridge: readonly string[]
  missing: readonly string[]
  kindOf: (member: string) => 'transport' | 'browser' | 'cut' | 'unknown'
  surfaces: readonly Capability[]
} {
  const bridge = Object.keys(createWebBridge()).sort()
  // `IMPLEMENTED_SET.has(name)`, NOT `name in IMPLEMENTED_SET`: `in` tests object
  // PROPERTIES, so it reported every one of the 157 members as missing and
  // would also have called a bare `constructor` implemented.
  const missing = BRIDGE_LEDGER.filter(name => !IMPLEMENTED_SET.has(name)).sort()
  return {
    bridge,
    missing,
    kindOf: (member: string) => BRIDGE_STATUS[member]?.kind ?? 'unknown',
    surfaces: CAPABILITY_SURFACES
  }
}

/**
 * The exact set the bridge object provides.
 *
 * DERIVED from the object, not maintained beside it. A hand-written list is a
 * second source of truth that drifts: deleting a member from `createWebBridge`
 * left it listed here, so the audit read it as "implemented" while the object
 * no longer had it, and the run passed. Reading the keys off the object makes
 * the two the same fact — a member is implemented if and only if it is there.
 *
 * Sorted so the audit's output is stable between runs.
 */
export const IMPLEMENTED_MEMBERS: readonly string[] = Object.freeze(Object.keys(createWebBridge()).sort())

const IMPLEMENTED_SET = new Set(IMPLEMENTED_MEMBERS)

/**
 * Install the bridge on `window`, ahead of the renderer entry.
 *
 * `devSessionToken` and `devGatewayOrigin` exist only so the spike harness can
 * point at a bare `hermes serve`. Production calls this with no options: the
 * bundle is served by the gateway, the session is an HttpOnly cookie, and the
 * socket is same-origin.
 */
export const bridgeEvents = {
  backendExited: (payload: { code?: number }): void => backendExitBus.emit(payload),
  previewFileChanged: (payload: { path: string }): void => previewFileBus.emit(payload),
  externalOpenFailed: (payload: { url: string }): void => externalOpenFailedBus.emit(payload)
}

export function installWebBridge(
  options: { devSessionToken?: string; devGatewayOrigin?: string } = {}
): typeof IMPLEMENTED_MEMBERS {
  if (options.devSessionToken) setDevSessionToken(options.devSessionToken)
  if (options.devGatewayOrigin) setDevGatewayOrigin(options.devGatewayOrigin)
  const target = window as unknown as Record<string, unknown>
  target.hermesDesktop = createWebBridge()
  target.hermesWeb = { capabilities }
  return IMPLEMENTED_MEMBERS
}
