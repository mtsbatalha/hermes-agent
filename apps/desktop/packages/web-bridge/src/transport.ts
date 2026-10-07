/**
 * Same-origin transports for the web client.
 *
 * Everything here talks to the Hermes backend that SERVED this bundle. There is
 * no second origin and no long-lived credential in the browser:
 *
 *   - REST carries an `HttpOnly` session cookie, which JS cannot read and does
 *     not need to. During local development against a bare `hermes serve` the
 *     token can be injected by the host page; the header is the dev-only path.
 *   - The gateway WebSocket cannot use the REST header. On a public bind it
 *     presents a single-use ticket in `Sec-WebSocket-Protocol`; on a loopback
 *     dev bind the credential rides `?token=`. See CAPABILITY-MATRIX.md,
 *     "the gated ticket leg" — that asymmetry is a server fact, not a choice.
 *
 * No placeholder shapes live here. Every function either returns data the server
 * actually sent, or throws `BridgeError` naming the request that failed.
 */

/**
 * Plain fields rather than TypeScript parameter properties: this file is
 * imported both by Vite and directly by Node (which type-strips in
 * "erasable syntax only" mode, where a parameter property is a hard error).
 */
export class BridgeError extends Error {
  readonly member: string
  readonly detail: string

  constructor(member: string, detail: string, options?: { cause?: unknown }) {
    super(`${member}: ${detail}`)
    this.name = 'BridgeError'
    this.member = member
    this.detail = detail
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Set by the host page ONLY in development, where a bare `hermes serve` mints a
 * token and injects it into the served HTML. Empty in production, where the
 * session is an HttpOnly cookie the client never sees.
 */
let devSessionToken = ''
let devGatewayOrigin = ''

export function setDevSessionToken(token: string): void {
  devSessionToken = token
}

/**
 * Development only: dial the gateway directly instead of the serving origin.
 *
 * The spike measured that a Vite preview proxy cannot carry this upgrade — the
 * handshake opens and then dies with ECONNRESET/1006, while the identical
 * handshake straight at the gateway opens and stays up. Production has no
 * override at all: the bundle is served BY the gateway, so same-origin is the
 * real configuration and this stays empty.
 */
export function setDevGatewayOrigin(origin: string): void {
  devGatewayOrigin = origin.replace(/\/$/, '')
}

/** The origin the gateway socket is dialed on. Same-origin unless overridden. */
export function gatewayOrigin(): string {
  return devGatewayOrigin || location.origin
}

/**
 * Build a gateway WebSocket URL from the serving origin.
 *
 * The scheme is swapped on a parsed URL rather than interpolated as a string.
 * Interpolating produced `ws://` + `http://127.0.0.1:9119`, which the URL parser
 * reads as the host `http` — the socket then dialed `ws://http/api/ws` and died
 * with ERR_NAME_NOT_RESOLVED, which surfaced to the user as "Hermes couldn't
 * start" with no indication that the bridge, not the gateway, was at fault.
 */
function gatewaySocketUrl(path: string): URL {
  const url = new URL(gatewayOrigin())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url
}

export type ApiRequest = {
  path: string
  method?: string
  body?: unknown
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer; path?: string; overwrite?: boolean }
  timeoutMs?: number
  profile?: string | null
  connection?: string | null
}

export type ApiOptions = Omit<ApiRequest, 'path'>

/**
 * The REST funnel: `api(path, options, member)`.
 *
 * `member` exists so a failure names the bridge member that made the call —
 * "readDir: GET /api/fs/list -> 404" — instead of a bare 404 nobody can trace
 * back to the UI.
 */
export async function api<T>(path: string, options: ApiOptions = {}, member = 'api'): Promise<T> {
  const { method = 'GET', body, upload, timeoutMs, profile: scope } = options
  const headers: Record<string, string> = {}
  if (devSessionToken) headers['X-Hermes-Session-Token'] = devSessionToken

  const init: RequestInit = { method, headers, credentials: 'same-origin' }
  if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs)

  if (upload) {
    const form = new FormData()
    form.append(
      'file',
      new Blob([upload.bytes], { type: upload.contentType ?? 'application/octet-stream' }),
      upload.filename
    )
    if (upload.path !== undefined) form.append('path', upload.path)
    if (upload.overwrite !== undefined) form.append('overwrite', String(upload.overwrite))
    init.body = form
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  // Scope by profile only for a real non-empty string. The renderer passes
  // `null`/`undefined` for the primary profile, and interpolating a placeholder
  // here puts the literal "undefined" in the query — which is exactly the
  // composite-scope bug the spike traced.
  //
  // Measured duplicate: paths that already carry `?profile=` (the timeline
  // index does, matching history-window.ts and api/sessions.ts) came out as
  // `...&profile=default&profile=default` on the wire. FastAPI tolerates the
  // repeat, so it is cosmetic today, but the URL is the contract between the
  // two halves and a future handler that reads the LAST value would silently
  // change meaning. Appending only when absent keeps both layers' intent.
  const profile = typeof scope === 'string' && scope.length > 0 ? scope : null
  const url =
    profile && !new URLSearchParams(path.split('?')[1] ?? '').has('profile')
      ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
      : path

  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new BridgeError(member, `${method} ${url} -> ${response.status} ${text.slice(0, 200)}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export type GatewayWsUrlResult = { ok: boolean; wsUrl?: string; error?: string }

/**
 * The gateway socket URL.
 *
 * `gateway.ready` proves the handshake, so this returns the URL and lets the
 * renderer's own socket code own the failure. It never invents a host: the
 * origin is the one that served this bundle, so the credential can stay
 * same-origin.
 */
export async function gatewayWsUrl(_profile?: string | null): Promise<GatewayWsUrlResult> {
  const url = gatewaySocketUrl('/api/ws')
  // Development only: a bare loopback `hermes serve` has no cookie session, so
  // the handshake needs the token in the query. Measured necessity — see
  // CAPABILITY-MATRIX.md. In production this stays empty and the server expects
  // a ticket in Sec-WebSocket-Protocol instead.
  if (devSessionToken) url.searchParams.set('token', devSessionToken)
  return { ok: true, wsUrl: url.toString() }
}

/**
 * The resize escape the server consumes in-band. `_RESIZE_RE` in
 * `hermes_cli/web_server_chat.py` matches it at the START of a frame and only
 * applies it when it is the WHOLE frame (`match.end() == len(raw)`), so a
 * resize must go out alone — appended to a keystroke it is written to the PTY
 * as literal text.
 */
const RESIZE_PREFIX = '\x1b[RESIZE:'

/**
 * The PTY transport behind the terminal pane.
 *
 * MEASURED against the live gateway, not assumed. `/api/pty`
 * (`hermes_cli/web_routers/chat_ws.py`) speaks RAW PTY BYTES in both
 * directions — `ws.send_bytes(chunk)` outbound to xterm, `msg["bytes"]`
 * inbound — not a JSON envelope. An earlier revision of this file sent
 * `{type:'start'|'input'|'resize'}` JSON, which the server happily wrote
 * straight into the child's stdin as literal text: a connected socket that
 * produced a TUI nobody could type into.
 *
 * The two exceptions, both measured on the wire:
 *   - the server sends `{"type":"resume","id":...}` as a TEXT frame to announce
 *     an implicit session replay, so a JSON-looking frame is control, not output
 *   - when no PTY is available it sends a human-readable explanation and closes
 *     1011, which `start()` surfaces instead of a bare failure
 */
export type PtyExit = { code: number | null; signal: string | null }

export class PtySocket {
  private socket: WebSocket | null = null
  private readonly queue: string[] = []
  private readonly listeners = new Set<(chunk: string) => void>()
  private readonly exits = new Set<(exit: PtyExit) => void>()
  private lastFrame = ''
  private refusal = ''

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /**
   * The server's REFUSAL copy, or '' when it has not refused.
   *
   * Deliberately NOT "the last frame": a healthy PTY streams terminal output
   * immediately, so last-frame would report a refusal on every successful start.
   * A refusal is the terminal's own words sent on a socket that is not going to
   * stream — which is why the exit handler latches it.
   */
  get refused(): string {
    return this.refusal
  }

  async connect(options?: { cwd?: string; attach?: string; profile?: string | null }): Promise<void> {
    if (this.socket) return
    const url = gatewaySocketUrl('/api/pty')
    if (devSessionToken) url.searchParams.set('token', devSessionToken)
    if (options?.cwd) url.searchParams.set('cwd', options.cwd)
    // `attach` opts into the keep-alive registry: the PTY outlives this socket
    // and a later connect with the same token reattaches to the same child.
    if (options?.attach) url.searchParams.set('attach', options.attach)
    if (typeof options?.profile === 'string' && options.profile.length > 0) {
      url.searchParams.set('profile', options.profile)
    }

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new BridgeError('terminal', 'PTY upgrade failed')), {
        once: true
      })
    })

    socket.addEventListener('message', event => this.onFrame(event.data))
    socket.addEventListener('close', event => {
      this.socket = null
      // 1011 is the server's "I am refusing to start this" code; anything else
      // is an ordinary disconnect and must not read as a refusal.
      if (event.code === 1011) this.refusal = this.lastFrame
      for (const notify of this.exits) notify({ code: event.code, signal: null })
    })

    // Flush onto the socket this call opened, not `this.socket`: a close that
    // landed during the upgrade nulls the field. Queued input is then dropped
    // rather than written to a dead socket — the exit handler reports the close.
    for (const frame of this.queue.splice(0)) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    }
  }

  private onFrame(data: unknown): void {
    const raw = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ''
    if (!raw) return

    // The server's only JSON outbound is the resume announcement.
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { type?: string }
        if (parsed?.type === 'resume') return
      } catch {
        // Not control JSON — fall through and treat it as terminal output.
      }
    }

    // A start failure arrives as an explanation followed by close 1011; keep it
    // so `start()` can report the server's own words.
    this.lastFrame = raw
    for (const notify of this.listeners) notify(raw)
  }

  /** Keystrokes, written to the child's stdin verbatim. */
  write(data: string): void {
    this.send(data)
  }

  /**
   * Resize. Its OWN frame by construction — see RESIZE_PREFIX. The server
   * consumes it and never forwards it to the child.
   */
  resize(size: { cols: number; rows: number }): void {
    this.send(`${RESIZE_PREFIX}${size.cols};${size.rows}]`)
  }

  private send(frame: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame)
    else this.queue.push(frame)
  }

  onData(callback: (chunk: string) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  onExit(callback: (exit: PtyExit) => void): () => void {
    this.exits.add(callback)
    return () => this.exits.delete(callback)
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
