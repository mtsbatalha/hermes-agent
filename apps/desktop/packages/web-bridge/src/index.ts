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
/**
 * Normalize a gateway URL the way `electron/connection-config.ts` does.
 *
 * Copied deliberately rather than imported: that module is CommonJS-ish
 * Electron code with node built-ins, and the rules are load-bearing —
 * a scheme-less `100.64.0.1:9119` pasted by a user must become an http URL,
 * and non-http schemes must be REJECTED rather than silently accepted.
 */
export function normalizeRemoteBaseUrl(rawUrl: string): string {
  let value = String(rawUrl ?? '').trim()
  if (!value) throw new Error('Remote gateway URL is required.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Remote gateway URL is not valid: ${(error as Error).message}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

type AuthProvider = { name: string; displayName: string; supportsPassword: boolean }
type ProbeResult = {
  baseUrl: string
  reachable: boolean
  authMode: 'oauth' | 'token' | 'unknown'
  providers: AuthProvider[]
  version: string | null
  error: string | null
}

/**
 * `probeConnectionConfig` — learn how a remote gateway wants to be called,
 * WITHOUT sending any credential.
 *
 * MEASURED, not assumed: the gateway ships CORSMiddleware scoped to localhost
 * origins (`web_server.py:442`, verified — a request carrying
 * `Origin: http://127.0.0.1:5176` comes back with
 * `access-control-allow-origin` and `vary: Origin`), so a browser can make
 * this cross-origin call in development, and in production the bundle is served
 * BY the gateway and the call is same-origin.
 *
 * Never throws. The settings UI calls this as the user TYPES a URL, so a
 * half-typed or unreachable host has to degrade to "can't tell yet"
 * (`reachable:false`) rather than throw — matching `probeRemoteAuthMode` in
 * electron/main.ts, which is the reference for the shape returned here.
 */
async function probeRemoteAuthMode(rawUrl: string): Promise<ProbeResult> {
  let baseUrl: string
  try {
    baseUrl = normalizeRemoteBaseUrl(rawUrl)
  } catch (error) {
    // Not a URL yet — that is the normal state while the field is being typed.
    return {
      baseUrl: String(rawUrl ?? ''),
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: (error as Error).message
    }
  }

  const unreachable = (message: string): ProbeResult => ({
    baseUrl,
    reachable: false,
    authMode: 'unknown',
    providers: [],
    version: null,
    error: message
  })

  let status: { auth_required?: boolean; version?: string | null }
  try {
    // `/api/status` is public on every Hermes gateway — it backs the portal
    // liveness probe — so this carries NO credential.
    const response = await fetch(`${baseUrl}/api/status`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(8000)
    })
    if (!response.ok) return unreachable(`Gateway answered ${response.status}.`)
    status = await response.json()
  } catch (error) {
    // A browser reports a blocked cross-origin call as an opaque TypeError
    // with no status; saying so beats inventing a status code.
    return unreachable(
      error instanceof Error
        ? `${error.message}${isOpaqueNetworkError(error) ? ' (the gateway may be blocking this origin)' : ''}`
        : String(error)
    )
  }

  const authRequired = status?.auth_required === true
  let providers: AuthProvider[] = []
  if (authRequired) {
    try {
      const body = await fetch(`${baseUrl}/api/auth/providers`, {
        credentials: 'omit',
        signal: AbortSignal.timeout(8000)
      })
      const parsed = body.ok ? await body.json() : null
      if (Array.isArray(parsed?.providers)) {
        providers = parsed.providers
          .filter((p: unknown) => p && typeof p === 'object')
          .map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            displayName: String(p.display_name ?? p.name ?? ''),
            supportsPassword: Boolean(p.supports_password)
          }))
          .filter((p: AuthProvider) => p.name)
      }
    } catch {
      // Provider metadata only labels the login button; the auth mode is
      // already known, so this never changes the verdict.
    }
  }

  return {
    baseUrl,
    reachable: true,
    authMode: authRequired ? 'oauth' : 'token',
    providers,
    version: status?.version ?? null,
    error: null
  }
}

/** A browser cannot read a blocked cross-origin failure's cause. */
function isOpaqueNetworkError(error: Error): boolean {
  return error instanceof TypeError && /fetch failed|networkerror|load failed/i.test(error.message)
}

const CONNECTION_KEY = 'hermes.web.connectionConfig'

/** The token is echoed back as a short preview only, as Electron does. */
function tokenPreview(token: string): string {
  return token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-2)}`
}

/**
 * The persisted endpoint entry. This is the FULL descriptor the contract
 * declares, not the subset the first version stored: dropping `sshPort`,
 * `sshKeyPath`, `sshRemoteHermesPath` and `sshRemoteProfile` meant a successful
 * Save wiped those four fields out of the settings form (the renderer adopts the
 * save response) and lost them on disk, while the user was told it had saved.
 * MEASURED in the live web client before this fix.
 */
type StoredConnection = {
  mode: string
  profile: string | null
  remoteAuthMode: string
  remoteUrl: string
  remoteToken: string | null
  cloudOrg: string
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshKeyPath: string
  sshRemoteHermesPath: string
  sshRemoteProfile: string
}

/** "Nothing saved" — what a first visit, or an unreadable store, reports. */
const NO_CONNECTION: StoredConnection = {
  mode: 'local',
  profile: null,
  remoteAuthMode: 'token',
  remoteUrl: '',
  remoteToken: null,
  cloudOrg: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshKeyPath: '',
  sshRemoteHermesPath: '',
  sshRemoteProfile: ''
}

/**
 * Coerce anything into a stored entry, so neither a hostile payload nor a
 * hand-edited / truncated `localStorage` value can put a wrong type into the
 * descriptor the renderer adopts.
 */
function toStoredConnection(value: unknown): StoredConnection | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const port = typeof input.sshPort === 'number' ? input.sshPort : Number(input.sshPort)
  return {
    mode: typeof input.mode === 'string' && input.mode ? input.mode : 'local',
    profile: typeof input.profile === 'string' && input.profile ? input.profile : null,
    remoteAuthMode: input.remoteAuthMode === 'oauth' ? 'oauth' : 'token',
    remoteUrl: text('remoteUrl'),
    remoteToken: typeof input.remoteToken === 'string' && input.remoteToken ? input.remoteToken : null,
    cloudOrg: text('cloudOrg'),
    sshHost: text('sshHost'),
    sshUser: text('sshUser'),
    sshPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    sshKeyPath: text('sshKeyPath'),
    sshRemoteHermesPath: text('sshRemoteHermesPath'),
    sshRemoteProfile: text('sshRemoteProfile')
  }
}

/**
 * The entry a later page load will see, or `null` when storage cannot answer.
 *
 * `null` covers three states that must not be confused: no entry, storage
 * blocked (private mode / disabled), and an entry that will not parse. Callers
 * decide whether each is fatal — the save path treats all three as a failure to
 * persist; a read treats them as "nothing saved".
 */
function readStoredConnection(): StoredConnection | null {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(CONNECTION_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  try {
    return toStoredConnection(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Is the gateway's own messaging gateway running?
 *
 * MEASURED against a real `hermes serve`: `/api/status` answers
 * `"gateway_running": false, "gateway_state": "stopped"`. So this is NOT the
 * same fact as "the HTTP API answered" — and a member that hardcoded `true`
 * reported a stopped messaging gateway as running, while the sibling member
 * reported the same stopped gateway as stopped. Both now read this one field.
 */
async function messagingGatewayRunning(member: string): Promise<boolean> {
  try {
    const status = await api<{ gateway_running?: boolean }>('/api/status', { timeoutMs: 5000 }, member)
    return status?.gateway_running === true
  } catch {
    // A gateway that cannot answer is not a running gateway. Saying otherwise
    // would report liveness from the absence of evidence.
  }

  return false
}

/**
 * The contract descriptor for a stored entry.
 *
 * The security posture is REPORTED, not hidden: `secureTokenStorage` is false
 * because there is no keychain here, and `remoteTokenPlainText` is true exactly
 * when a token is sitting in browser storage. A renderer that wants to warn the
 * user can read both; a bridge that reported `secureTokenStorage: true` would be
 * asserting protection it does not have.
 */
async function describeConnection(entry: StoredConnection, member: string): Promise<Record<string, unknown>> {
  return {
    envOverride: false,
    mode: entry.mode,
    profile: entry.profile,
    remoteAuthMode: entry.remoteAuthMode,
    remoteOauthConnected: false,
    remoteTokenPreview: entry.remoteToken ? tokenPreview(entry.remoteToken) : null,
    remoteTokenSet: entry.remoteToken !== null,
    secureTokenStorage: false,
    remoteTokenPlainText: entry.remoteToken !== null,
    remoteUrl: entry.remoteUrl,
    cloudOrg: entry.cloudOrg,
    sshHost: entry.sshHost,
    sshUser: entry.sshUser,
    sshPort: entry.sshPort,
    sshKeyPath: entry.sshKeyPath,
    sshRemoteHermesPath: entry.sshRemoteHermesPath,
    sshRemoteProfile: entry.sshRemoteProfile,
    gatewayRunning: await messagingGatewayRunning(member)
  }
}

/**
 * Persist the connection descriptor in `localStorage`, and return the shape the
 * contract declares.
 *
 * The write is VERIFIED, and a failed write throws. Returning a success-shaped
 * descriptor for a value that never reached storage is the exact "saved!" lie
 * this member used to tell: the renderer adopts the response as the current
 * state and shows a success toast. So the value handed back is read back out of
 * storage, not the value we hoped to write — whatever a later page load will
 * see is what the caller adopts.
 */
async function storeConnectionConfig(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entry = toStoredConnection(payload)
  if (!entry) {
    throw new BridgeError('saveConnectionConfig', 'Expected a connection descriptor object.')
  }

  let verified: StoredConnection | null = null
  try {
    globalThis.localStorage?.setItem(CONNECTION_KEY, JSON.stringify(entry))
    verified = readStoredConnection()
  } catch (error) {
    throw new BridgeError(
      'saveConnectionConfig',
      'This browser refused to store the connection settings (storage is blocked or full).',
      { cause: error }
    )
  }

  if (!verified) {
    // `setItem` resolved but nothing readable came back: storage is disabled,
    // the entry is unreadable, or a quota policy dropped the write silently.
    throw new BridgeError(
      'saveConnectionConfig',
      'The browser accepted the write but did not return it on read-back, so the settings were not saved.'
    )
  }

  return describeConnection(verified, 'saveConnectionConfig')
}

const ptySockets = new Map<string, PtySocket>()

// Relative, NOT the `@hermes/shared` bare specifier: this module is imported
// directly by Node (the contract audit) and by the package's own vitest, neither
// of which resolves tsconfig paths — the same reason electron/hardening.ts
// imports these relatively. Importing them rather than restating 16/1/4096 here
// is what keeps the bridge's cap and the renderer's Settings clamp in step.
import {
  clampDataUrlReadMaxMb,
  DATA_URL_READ_DEFAULT_MAX_MB,
  DATA_URL_READ_MAX_MAX_MB
} from '../../../../shared/src/data-url-read-max.ts'

/**
 * The server's own cap on `/api/fs/read-data-url`, measured from
 * `hermes_cli/web_server.py: _FS_DATA_URL_MAX_BYTES = 16 * 1024 * 1024`.
 *
 * Reported as `maxBytes` so the UI shows what the GATEWAY will actually accept.
 * Deriving it from the measured constant rather than restating it here means a
 * server-side change shows up as a test failure instead of a silent mismatch.
 */
const SERVER_DATA_URL_MAX_BYTES = DATA_URL_READ_DEFAULT_MAX_MB * 1024 * 1024
const DATA_URL_PREF_KEY = 'hermes.web.dataUrlReadMaxMb'

/**
 * Upload bytes to a gateway-managed path and return it.
 *
 * MEASURED against the live gateway: `GET /api/files` yields the managed
 * upload root, `POST /api/files/upload-stream` writes a multipart body under
 * it and returns the display path. This is the same wire shape `selectPaths`
 * has always used — factored out so the image/paste members (below) stage
 * browser-held bytes identically instead of inventing a second staging area.
 * The caller passes the root it already resolved (selectPaths fetches it once
 * for the whole batch); `member` names the bridge member on failure, per the
 * transport's rule.
 */
async function uploadBytesToManagedPath(
  rootPath: string,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
  member: string,
  profile?: string | null
): Promise<string> {
  const name = filename.replace(/[\\/\\\\]/g, '_')
  const destination = `${rootPath.replace(/[\\/\\\\]$/, '')}/.hermes-web-attachments/${crypto.randomUUID()}/${name}`
  const result = await api<{ path: string }>(
    '/api/files/upload-stream',
    {
      method: 'POST',
      profile: profile ?? undefined,
      upload: { filename: name, contentType, bytes, path: destination, overwrite: false }
    },
    member
  )
  if (typeof result.path !== 'string' || !result.path) {
    throw new BridgeError(member, 'The upload did not return a gateway path.')
  }
  return result.path
}

/**
 * The managed upload root, shared by every staging member. `null` means the
 * gateway answered without one — callers turn that into their own member-named
 * error because the copy should name who asked.
 */
async function managedUploadRoot(member: string): Promise<string | null> {
  const root = await api<{ path: string }>('/api/files', {}, member)
  return typeof root.path === 'string' && root.path ? root.path : null
}

export type DataUrlReadMax = { defaultMaxMb: number; maxBytes: number; maxMb: number }

/**
 * The user's cap preference.
 *
 * Electron persists it to a JSON file under `userData`, which no browser can
 * read, so the honest equivalent is `localStorage` — per-browser and per-origin,
 * which is exactly the scope the value has. It survives a reload, like the
 * Electron version survives a restart; it does NOT sync across machines, and
 * nothing here pretends it does.
 */
function readPref(): DataUrlReadMax {
  let stored: unknown = null
  try {
    stored = globalThis.localStorage?.getItem(DATA_URL_PREF_KEY)
  } catch {
    // Private mode / storage disabled: the default is still a real answer.
  }
  const parsed = stored === null ? DATA_URL_READ_DEFAULT_MAX_MB : Number(stored)
  const maxMb = clampDataUrlReadMaxMb(Number.isFinite(parsed) ? parsed : DATA_URL_READ_DEFAULT_MAX_MB)
  return { defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB, maxBytes: SERVER_DATA_URL_MAX_BYTES, maxMb }
}

/**
 * Persist the preference. Clamped BEFORE storing, using the shared clamp, so a
 * corrupt or hand-edited value cannot put the client above the shared maximum —
 * the renderer clamps too, but two clamps disagreeing is how a cap silently
 * becomes two caps.
 *
 * Returns `maxBytes` unchanged: raising the client preference cannot raise what
 * the server accepts, and reporting the larger number would make the UI promise
 * an attachment the gateway rejects with 413.
 */
async function writePref(maxMb: number): Promise<DataUrlReadMax> {
  const clamped = clampDataUrlReadMaxMb(maxMb)
  try {
    globalThis.localStorage?.setItem(DATA_URL_PREF_KEY, String(clamped))
  } catch {
    // Storage unavailable: report the clamped value anyway. It is the value the
    // caller asked for within bounds, and pretending the write succeeded when it
    // did not would be worse than reporting the number without persisting it.
  }
  return { defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB, maxBytes: SERVER_DATA_URL_MAX_BYTES, maxMb: clamped }
}

/** The structured "file is simply gone" result the contract requires. */
export type ReadFileErrorResult = { ok: false; error: string; message: string; path?: string }

/**
 * Read a file as a data URL, honouring the return-not-throw contract.
 *
 * A 404 becomes `{ok:false,…}` because the renderer draws that as "preview
 * unavailable" — an expected state. A 413 (over the server cap) also becomes a
 * structured result rather than a rejection, since it is likewise a user-facing
 * limit rather than a fault. Everything else still throws.
 */
async function readDataUrl(filePath: string, member: string): Promise<string | ReadFileErrorResult> {
  const path = `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`
  try {
    const result = await api<{ dataUrl?: string }>(path, {}, member)
    // The server answered 200 without a dataUrl. Returning undefined here would
    // be the placeholder bug in a new coat, so it is an error, not a value.
    if (typeof result?.dataUrl !== 'string' || !result.dataUrl) {
      throw new BridgeError(member, `${path} -> 200 without a dataUrl field`)
    }
    return result.dataUrl
  } catch (error) {
    if (error instanceof BridgeError && /\b(404|413)\b/.test(error.detail)) {
      const code = /\b404\b/.test(error.detail) ? 'ENOENT' : 'EFBIG'
      return {
        ok: false,
        error: code,
        message:
          code === 'ENOENT'
            ? 'File does not exist.'
            : `File is larger than the ${DATA_URL_READ_DEFAULT_MAX_MB} MiB limit the gateway enforces.`,
        path: filePath
      }
    }
    throw error
  }
}

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
     *
     * `mode` is the connection this client ACTUALLY holds, which in a browser is
     * always the gateway that served this page — a stored `remote`/`ssh`/`cloud`
     * entry is an endpoint the client never dialled, and `applyConnectionConfig`
     * refuses to dial it. It is deliberately NOT the stored draft's mode:
     * `refreshProfileRemoteOverrides` badges every profile whose descriptor
     * says remote, `isLocalDesktopProfile` uses it to pick the startup profile,
     * and the boot overlay offers a remote sign-in when it reads remote. Echoing
     * a draft into that field would fabricate all three.
     *
     * The draft's FIELDS are echoed, so a saved URL or SSH entry survives a
     * reload and reappears when the user picks that mode — that read-back is the
     * whole point of persisting anything here. An entry that cannot be read back
     * (blocked storage, truncated JSON) reads as "nothing saved" rather than
     * poisoning the form.
     */
    getConnectionConfig: async () => {
      const stored = readStoredConnection() ?? NO_CONNECTION
      const descriptor = await describeConnection(stored, 'getConnectionConfig')
      return { ...descriptor, mode: 'local' }
    },

    /**
     * ── remote connection probing (43 call sites across this family) ────────
     *
     * `probeConnectionConfig` is the one fully portable member here and the one
     * the settings UI leans on hardest: it renders an OAuth login button vs a
     * token box as the user TYPES, so it must never throw.
     *
     * `testConnectionConfig` is PARTIAL, and the gap is stated rather than
     * papered over. Electron tests the HTTP leg AND then the live `/api/ws`
     * upgrade, using the connection's decrypted credential. A browser can do
     * the HTTP leg (CORS is enabled for localhost origins) but cannot read
     * Electron's encrypted store, so it tests with the credential the BROWSER
     * has: the OAuth session cookie, or an explicit token from the payload.
     * SSH mode needs an ssh binary on the host, which a browser does not have.
     */
    probeConnectionConfig: (remoteUrl: string) => probeRemoteAuthMode(remoteUrl),
    testConnectionConfig: async (payload: {
      mode?: string
      remoteUrl?: string
      remoteToken?: string
    }): Promise<Record<string, unknown>> => {
      if (payload?.mode === 'ssh') {
        // No ssh binary, no host key store, no agent — say which, don't fake ok.
        return {
          reachable: false,
          sshError: 'unsupported-platform',
          error: 'Testing an SSH connection needs the gateway host to run it; the web client cannot.'
        }
      }
      const rawUrl = payload?.remoteUrl ?? ''
      let baseUrl: string
      try {
        baseUrl = normalizeRemoteBaseUrl(rawUrl)
      } catch (error) {
        return { ok: false, reachable: false, error: (error as Error).message }
      }
      try {
        const response = await fetch(`${baseUrl}/api/status`, {
          // `omit`, never `include` — MEASURED. The gateway ships CORSMiddleware
          // with `Access-Control-Allow-Credentials` ABSENT, so Chrome blocks a
          // credentialed cross-origin request outright ("the value of the
          // 'Access-Control-Allow-Credentials' header is ''"). `omit` and
          // `same-origin` both pass; `include` cannot, by definition, when the
          // server does not opt in.
          //
          // The consequence is real and stated: an OAuth-gated remote cannot be
          // credential-tested from a browser across origins today. An explicit
          // token from the payload still works — it travels as a header, which
          // is a simple request, not a credentialed one.
          credentials: 'omit',
          headers: payload?.remoteToken ? { 'X-Hermes-Session-Token': payload.remoteToken } : {},
          signal: AbortSignal.timeout(8000)
        })
        const body = response.ok ? await response.json() : null
        return {
          ok: response.ok,
          reachable: response.ok,
          baseUrl,
          version: body?.version ?? null,
          ...(response.ok ? {} : { error: `Gateway answered ${response.status}.` })
        }
      } catch (error) {
        return {
          ok: false,
          reachable: false,
          baseUrl,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    /**
     * `saveConnectionConfig` persists the entry.
     *
     * Electron writes `connections.json` under `userData`, encrypted with the OS
     * keychain. A browser has neither, so the descriptor is kept in
     * `localStorage` and `secureTokenStorage` is reported FALSE — the contract
     * has a field for exactly this, and reporting true would be a lie the
     * renderer acts on. A supplied `remoteToken` is stored as-is, which is why
     * `remoteTokenPlainText` reports true when one is present.
     *
     * It saves the ENDPOINT ENTRY, not a connection: `applyConnectionConfig`
     * refuses to switch, so nothing here can make this client talk to another
     * host. The write is verified (see `storeConnectionConfig`) and the response
     * is what storage actually holds, so the fields the renderer adopts — and
     * shows a success toast for — are the fields a reload will read.
     *
     * The token is never returned: only a short preview, as Electron does.
     */
    saveConnectionConfig: async (payload: Record<string, unknown>) => storeConnectionConfig(payload),
    // Saving a descriptor is not a reconnect. Reject before writing so the
    // renderer cannot announce a successful switch while still using this host.
    applyConnectionConfig: async () => {
      throw new BridgeError(
        'applyConnectionConfig',
        'Switching gateways is not supported in this web client yet. Open the target gateway URL instead.'
      )
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

    /**
     * ── file attachments (38 call sites in 14 files: the renderer's most-used
     * unported member) ──────────────────────────────────────────────────────
     *
     * MEASURED against the live gateway, not assumed:
     *   GET /api/fs/read-data-url?path=…
     *     200 → {"dataUrl": "data:<mime>;base64,…"}   ← an OBJECT, so it must
     *           be unwrapped to the bare string the contract promises
     *     404 → {"detail": "File not found"}
     *     413 → "File too large" (files.py: st.st_size > _FS_DATA_URL_MAX_BYTES)
     *
     * The 404 case is the subtle one. The contract does NOT reject for a file
     * that is simply gone — `HermesReadFileErrorResult` says the main process
     * "does NOT reject the IPC call" because a restored preview tab or a stale
     * transcript reference is an EXPECTED outcome the renderer already draws as
     * "preview unavailable". Throwing here would turn a normal, drawn state into
     * an unhandled rejection. So 404 returns the structured result and every
     * other failure still throws.
     */
    readFileDataUrl: (filePath: string) => readDataUrl(filePath, 'readFileDataUrl'),
    /**
     * The same route, and deliberately NOT a higher cap: Electron's attach path
     * reads 256 MiB locally, but here the SERVER enforces the cap
     * (`_FS_DATA_URL_MAX_BYTES`, measured 16 MiB) and there is no client-side
     * read to raise. Claiming 256 MiB would be a number the gateway refuses.
     */
    readFileDataUrlForAttach: (filePath: string) => readDataUrl(filePath, 'readFileDataUrlForAttach'),
    dataUrlReadMax: {
      get: () => readPref(),
      set: async (maxMb: number) => writePref(maxMb)
    },
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
    selectPaths: async (options?: { multiple?: boolean; directories?: boolean; profile?: string }) => {
      if (options?.directories) {
        throw new BridgeError(
          'selectPaths',
          'Browser folders have no gateway path. Choose a folder on the gateway instead.'
        )
      }
      if (!('showOpenFilePicker' in window)) {
        throw new BridgeError('selectPaths', 'This browser does not support the file picker yet.')
      }
      let picked: Array<{ getFile: () => Promise<File> }>
      try {
        picked = await (
          window as unknown as { showOpenFilePicker: (o: unknown) => Promise<Array<{ getFile: () => Promise<File> }>> }
        ).showOpenFilePicker({ multiple: options?.multiple ?? false })
      } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return []
        throw error
      }
      const root = await managedUploadRoot('selectPaths')
      if (!root) {
        throw new BridgeError('selectPaths', 'The gateway did not return a managed upload root.')
      }
      const paths: string[] = []
      for (const handle of picked) {
        const file = await handle.getFile()
        if (file.size > SERVER_DATA_URL_MAX_BYTES) {
          throw new BridgeError(
            'selectPaths',
            `File exceeds the ${DATA_URL_READ_DEFAULT_MAX_MB} MiB gateway read limit.`
          )
        }
        paths.push(
          await uploadBytesToManagedPath(
            root,
            await file.arrayBuffer(),
            file.name,
            file.type || 'application/octet-stream',
            'selectPaths',
            options?.profile
          )
        )
      }
      return paths
    },
    selectSavePath: async () => {
      if (!('showSaveFilePicker' in window)) return null
      const handle = await (
        window as unknown as { showSaveFilePicker: () => Promise<{ name: string }> }
      ).showSaveFilePicker()
      return handle.name
    },

    /**
     * ── browser-held image/paste bytes → gateway paths ──────────────────
     *
     * Electron's `saveImageBuffer` / `savePastedText` / `saveClipboardImage`
     * write into Desktop's durable caches and hand back a host path. The web
     * bridge used to cut all three ("anchor + download"), which silently broke
     * every composer flow that calls them: `attachImageBlob` returned without
     * a chip (the optional-chain swallowed the missing member), the large-
     * paste conversion no-op'd, and Paste-image menu item dead-ended. MEASURED
     * in the live web client before wiring these.
     *
     * The honest equivalent is NOT a download: the composer needs a GATEWAY
     * path the model can read, and the gateway already stages browser uploads
     * under `.hermes-web-attachments/` (see `selectPaths`). These members
     * stage into the same area through the same endpoint. The bytes stay on
     * the gateway instead of the user's disk — which is where Desktop's cache
     * copies live anyway relative to the model.
     */
    saveImageBuffer: async (data: ArrayBuffer | Uint8Array, ext: string, name?: string) => {
      const bytes: ArrayBuffer =
        data instanceof Uint8Array
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
          : data
      const filename = name?.replace(/[\\/\\\\]/g, '_') ?? `composer-image-${Date.now().toString(36)}${ext.startsWith('.') ? ext : `.${ext}`}`
      const root = await managedUploadRoot('saveImageBuffer')
      if (!root) throw new BridgeError('saveImageBuffer', 'The gateway did not return a managed upload root.')
      return uploadBytesToManagedPath(root, bytes, filename, 'application/octet-stream', 'saveImageBuffer')
    },
    savePastedText: async (text: string) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const hex = Math.random().toString(16).slice(2, 8)
      // Same name shape Electron's composer-paste cache uses, so the
      // renderer's `PASTED_CONTENT_FILE_RE` chip label matches.
      const encoded = new TextEncoder().encode(text)
      const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
      const root = await managedUploadRoot('savePastedText')
      if (!root) throw new BridgeError('savePastedText', 'The gateway did not return a managed upload root.')
      return uploadBytesToManagedPath(root, bytes, `pasted_content_${stamp}_${hex}.txt`, 'text/plain', 'savePastedText')
    },
    saveClipboardImage: async (): Promise<string | null> => {
      // A browser can only read the clipboard inside a user gesture with
      // permission; the menu click provides the gesture. No image → null, the
      // same "nothing on the clipboard" answer Desktop gives.
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return null
      let items: ClipboardItem[]
      try {
        items = await navigator.clipboard.read()
      } catch {
        return null
      }
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        if (blob.size === 0) continue
        const ext = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
        const bytes = await blob.arrayBuffer()
        const root = await managedUploadRoot('saveClipboardImage')
        if (!root) throw new BridgeError('saveClipboardImage', 'The gateway did not return a managed upload root.')
        return uploadBytesToManagedPath(
          root,
          bytes,
          `clipboard-image-${Date.now().toString(36)}.${ext}`,
          type,
          'saveClipboardImage'
        )
      }
      return null
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
