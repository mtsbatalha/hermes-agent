/**
 * SPIKE ONLY — Fase 0 validation harness. Not product code, not a port.
 *
 * The Desktop renderer never imports Node or Electron: native power reaches it
 * through one narrow typed object, `window.hermesDesktop`, exposed by the
 * preload. This module provides that object to the SAME, UNMODIFIED renderer
 * running in a plain browser tab, so we can answer one question — does the
 * Desktop conversation hold up outside Electron?
 *
 * What is real here: the REST funnel (`api`) and the gateway WebSocket dial go
 * to a live `hermes serve`. What is absent: every native-only capability. This
 * is the point — anything the boot path needs but is not in this file is a
 * genuine finding about the web port, recorded in `__spike.missing`.
 */

const SESSION_TOKEN = 'spike-token-123'
const SESSION_HEADER = 'X-Hermes-Session-Token'

/** Everything the boot path touched but this harness does not implement. */
const missing: string[] = []
const accessed = new Set<string>()

function record(key: string): void {
  accessed.add(key)
  if (!missing.includes(key)) missing.push(key)
}

/**
 * Object-shaped placeholder: property reads keep yielding placeholders so a
 * deep access degrades instead of throwing. Deliberately NOT thenable — a
 * thenable that resolves to itself trips Promise's chaining-cycle guard.
 */
function inertValue(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => undefined
        if (prop === Symbol.iterator) return undefined
        if (prop === 'then') return undefined
        record(`${name}.${String(prop)}`)
        // Nested values are FULL placeholders, not bare objects: the renderer
        // calls string/array methods straight off bridge results
        // (`updateStatus.currentSha.slice`), so a non-callable here throws.
        return inert(`${name}.${String(prop)}`)
      }
    }
  )
  inertCache.set(name, created)
  return created
}

/**
 * Placeholder for a capability the web port does not have.
 *
 * The renderer reaches the bridge from module-level side-effect stores BEFORE
 * React renders anything, and it uses it in three incompatible shapes at once:
 *
 *  - `member.x` — a field read (namespaced members: `windowRelay.onMessage`)
 *  - `member(...)` — a CALL whose return value is then either awaited (REST-ish)
 *    or CALLED AGAIN as an unsubscribe (`onStatus(cb)` returns `offStatus`)
 *  - `await member(...)` — most members are async and callers chain `.then`
 *
 * So the placeholder has to be callable, awaitable and property-readable
 * simultaneously. `then` resolves to a distinct inert object rather than to
 * itself, which is what keeps `await` from deadlocking on a chaining cycle.
 */
const inertCache = new Map<string, unknown>()

function inert(name: string): unknown {
  // Stable referential identity. The real bridge hands back the SAME object for
  // a given capability; a factory that mints a new proxy per property read makes
  // every derived value change identity, which sends any effect keyed on it into
  // an update loop ("Maximum update depth exceeded").
  const cached = inertCache.get(name)
  if (cached) return cached

  const created = createInert(name)
  inertCache.set(name, created)
  return created
}

function createInert(name: string): unknown {
  // A REAL promise, settled on a macrotask. Two properties are load-bearing:
  //
  //  - It must be a real Promise so `x.then(f).catch(g)` chains. A hand-rolled
  //    `then` that returns undefined breaks the `.catch` half of every
  //    fire-and-forget call the renderer makes.
  //  - It must settle ASYNCHRONOUSLY. The real bridge always settles
  //    asynchronously (IPC, fetch, filesystem) and that asynchrony yields
  //    between the renderer's boot steps. A placeholder resolving inline lets
  //    React run effects before the gateway store finishes initializing, which
  //    surfaces as a `Cannot access 'gateway' before initialization` TDZ that
  //    has nothing to do with the web port.
  const promise = () => new Promise(resolve => setTimeout(() => resolve(inertValue(name)), 0))

  return new Proxy(
    function inertCallable(): unknown {
      record(`${name}()`)
      // Calling the result again is the unsubscribe idiom; it must stay callable.
      return inert(`${name}()`)
    },
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => undefined
        if (prop === Symbol.iterator) return undefined
        if (prop === 'then') return promise().then.bind(promise())
        if (prop === 'catch') return promise().catch.bind(promise())
        if (prop === 'finally') return promise().finally.bind(promise())
        record(`${name}.${String(prop)}`)
        return inert(`${name}.${String(prop)}`)
      }
    }
  )
}

/** REST funnel. Mirrors what Electron main does, minus routing and scoping. */
async function api<T>(request: {
  path: string
  method?: string
  body?: unknown
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }
  timeoutMs?: number
  profile?: string | null
  connection?: string | null
}): Promise<T> {
  const { path, method = 'GET', body, upload } = request
  const headers: Record<string, string> = { [SESSION_HEADER]: SESSION_TOKEN }
  const init: RequestInit = { method, headers }

  if (upload) {
    const form = new FormData()
    form.append('file', new Blob([upload.bytes], { type: upload.contentType ?? 'application/octet-stream' }), upload.filename)
    init.body = form
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  // Scope by profile ONLY for a real non-empty string. The renderer legitimately
  // passes `null`/`undefined` for the primary profile, and a placeholder would
  // otherwise be interpolated into the query as the literal "undefined", which
  // the gateway answers with a 404 for every startup call.
  const profile = typeof request.profile === 'string' && request.profile.length > 0 ? request.profile : null
  const query = profile ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}` : path

  const response = await fetch(query, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${query} -> ${response.status} ${text.slice(0, 200)}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Gateway dial. The credential rides as a QUERY PARAM — the gateway's WS
 * handshake reads `?token=` (loopback mode) or `?ticket=` (gated mode); it does
 * NOT accept the REST session header.
 *
 * Two facts measured here, both matter for the real port:
 *   1. The token in a URL lands in proxy access logs and browser history. That
 *      is why the plan's same-origin + HttpOnly cookie design has to replace
 *      this for the shipped client.
 *   2. Tunnelling this socket through the Vite dev proxy does NOT work — the
 *      upgrade opens and then dies with 1006. Straight at the gateway the same
 *      handshake opens, receives `gateway.ready`, and stays up. The client has to
 *      reach the backend on its own origin, which is exactly what serving the
 *      bundle from the backend achieves.
 */
const WS_ORIGIN = 'ws://127.0.0.1:9119'

const gatewayWsUrl = async () => ({
  ok: true,
  wsUrl: `${WS_ORIGIN}/api/ws?token=${encodeURIComponent(SESSION_TOKEN)}`
})

/**
 * Members the renderer needs to reach a first conversation. Each one is the
 * web-reachable equivalent of the Electron capability, not a fake success.
 */
const implemented: Record<string, unknown> = {
  api,
  getGatewayWsUrl: gatewayWsUrl,

  // The connection-scoped variant. The renderer picks this branch whenever the
  // member EXISTS, so both must return the same URL shape or the dial gets an
  // object where it needs a ws:// string. Async, because the caller chains
  // `.catch` on the result.
  getGatewayWsUrlFor: gatewayWsUrl,

  // The saved connection mode. THIS MEMBER IS LOAD-BEARING: left unimplemented it
  // returns a placeholder, the renderer reads `mode` as something other than
  // 'local', and the whole boot takes the remote/SSH resolution path. It then
  // publishes `$activeProfile` as the literal string "undefined", re-activates
  // forever (activation epoch 2 -> 3 -> ...), dials sockets for a connection that
  // does not exist and drops them, leaving `activeGateway()` null and
  // `$gatewayState` stuck at 'closed'. The composer reads `gatewayState !==
  // 'open'`, disables submit, and no `prompt.submit` is ever sent — which looks
  // exactly like "the renderer drops its gateway socket".
  getConnectionConfig: async () => ({
    envOverride: false,
    mode: 'local',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: null,
    remoteTokenSet: false,
    secureTokenStorage: false,
    remoteTokenStoredPlain: false
  }),

  // The resolved connection descriptor. Together with `profile.get` this is the
  // pair the boot path needs to name its active profile
  // (use-gateway-boot.ts: `override ?? (await desktop.profile?.get?.())?.profile
  // ?? ''`). Left as placeholders, that expression yields the string "undefined",
  // `normalizeProfileKey` passes it through, `g.primaryProfile` becomes
  // "undefined", the composite scope is `undefined::default`, and
  // `reportGatewayState` never publishes 'open' — leaving $gatewayState
  // 'closed' and the composer refusing to submit.
  getConnection: async (profile?: string | null) => ({
    baseUrl: 'http://127.0.0.1:9119',
    mode: 'local',
    isFullscreen: false,
    nativeOverlayWidth: 0,
    profile: typeof profile === 'string' && profile.length > 0 ? profile : 'default',
    source: 'local'
  }),

  getConnectionFor: async (route?: { profile?: string | null }) =>
    ({
      baseUrl: 'http://127.0.0.1:9119',
      mode: 'local',
      isFullscreen: false,
      nativeOverlayWidth: 0,
      profile: typeof route?.profile === 'string' && route.profile.length > 0 ? route.profile : 'default',
      source: 'local'
    }),

  // `profile.get` is the fallback the boot path reaches when neither the window
  // override nor `connection.profile` supplies a name. `null` is the honest
  // value here (no stored preference), and it normalizes to 'default'.
  profile: {
    get: async () => ({ profile: null }),
    getDefault: async () => ({ connectionId: null, profile: 'default' }),
    setDefault: async (route: unknown) => route,
    remember: async () => ({ profile: null }),
    onDefaultChanged: () => () => undefined
  },

  getVersion: () => Promise.resolve({ version: '0.21.5', build: 'spike' }),

  // Bootstrap is INSTALLING Hermes — the thing a web client never does. It
  // attaches to a gateway someone else is already running, so bootstrap is not
  // merely complete, it is inapplicable. Reporting a placeholder here is what
  // strands the browser on the "Set up Hermes Desktop" onboarding screen even
  // though the gateway is ready.
  getBootstrapState: () =>
    Promise.resolve({
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
  getBootProgress: () =>
    Promise.resolve({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'ready',
      progress: 1,
      running: false
    }),
  // Mirror POOL_LIMITS_DEFAULTS in src/store/pool-limits.ts. An earlier stub of
  // { maxBackends: 1, idleMs: 0 } retired every UNUSED pool backend instantly,
  // which spawned a profile-scoped secondary gateway and closed it again inside
  // half a second — churn that reads exactly like "the renderer drops its own
  // gateway socket".
  getPoolLimits: () => Promise.resolve({ maxBackends: 3, idleMs: 600_000 }),

  // Connection registry. Empty and primary='local': the browser client talks to
  // exactly one gateway, so there is nothing to enumerate and no per-host
  // routing to decide. A web client owns its connection out of band (URL +
  // session), not through a desktop registry.
  connections: {
    list: () => Promise.resolve({ version: 1, primary: 'local', launchMode: 'primary', connections: [] }),
    onChanged: () => () => undefined,
    test: () => Promise.resolve({ ok: true })
  },

  // Appearance falls back to the built-in skin, which is what a web client
  // should do anyway — custom skins are files on the Electron host.
  localSkin: null,

  // Desktop plugin roots are filesystem paths on the gateway host; the web has
  // no such tree, so report none rather than inventing one.
  desktopPluginsRoot: () => Promise.resolve(null),
  getProfileRoutes: () => Promise.resolve([]),
  readDir: () => Promise.resolve({ entries: [] }),
  watchDirectory: () => Promise.resolve({ id: 'spike' }),

  getMachineProfile: () =>
    Promise.resolve({
      platform: 'web',
      os: navigator.userAgent,
      arch: 'wasm',
      hostname: location.hostname,
      hermesHome: '(remote gateway)'
    }),

  // Native-only capabilities the web cannot honestly provide.
  glassSupported: () => false,
  translucencySupported: () => false,
  setNativeTheme: () => undefined,
  setTitleBarTheme: () => undefined,
  windowControls: inert('windowControls'),
  setKeepAwake: () => undefined,
  minimizeToTray: () => undefined,
  relaunchApp: () => undefined,
  openBrowserWindow: () => Promise.resolve(null),
  openSessionWindow: () => Promise.resolve(null),
  openSessionInTerminal: () => undefined,

  // Web-reachable clipboard.
  readClipboard: () => navigator.clipboard.readText(),
  writeClipboard: (text: string) => navigator.clipboard.writeText(text),

  // Web-reachable notification (best effort; permission may be denied).
  notify: async (payload: { title?: string; body?: string }) => {
    if (!('Notification' in window)) return false
    if (Notification.permission === 'granted') {
      new Notification(payload?.title ?? 'Hermes', { body: payload?.body })
      return true
    }
    return false
  },

  // The app routes its OWN identity diagnostics through this member
  // (lib/identity-trace.ts -> `logLine`). With it unimplemented those traces go
  // nowhere, which is exactly how the gateway-boot problem stayed invisible: the
  // renderer was telling us what it was doing and the harness was discarding it.
  logLine: (line: string) => {
    const traces = ((window as any).__trace ??= [])
    traces.push(line)
    if (traces.length > 600) traces.shift()
  },
  getRecentLogs: async () => (window as any).__trace ?? [],

  // File pickers: the File System Access API, where available.
  selectPaths: async (options?: { multiple?: boolean }) => {
    if (!('showOpenFilePicker' in window)) return []
    const picked = await (window as any).showOpenFilePicker({ multiple: options?.multiple ?? false })
    return picked.map((handle: any) => handle.name)
  },
  selectSavePath: async () => {
    if (!('showSaveFilePicker' in window)) return null
    const handle = await (window as any).showSaveFilePicker()
    return handle.name
  },

  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

const bridge = new Proxy(implemented, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined
    if (prop in target) return target[prop]
    return inert(prop)
  },
  has() {
    return true
  }
})

;(window as any).hermesDesktop = bridge
;(window as any).__spike = {
  missing,
  accessed: () => [...accessed].sort(),
  token: SESSION_TOKEN
}

console.info('[spike] hermesDesktop bridge installed (browser stub)')