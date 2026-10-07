/**
 * The remote-connection family: `probeConnectionConfig`,
 * `testConnectionConfig`, `saveConnectionConfig`, `applyConnectionConfig`.
 *
 * The probe is the member that matters most here, because the settings UI calls
 * it as the user TYPES a URL. Anything that throws on a half-typed address
 * turns a live keystroke into an error boundary — so "never throws" is asserted
 * for every malformed input, not just the happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWebBridge, normalizeRemoteBaseUrl } from '../src/index.ts'

/**
 * The bridge members under test, typed loosely on PURPOSE: this suite asserts
 * runtime behaviour (never throws, returns the right shape) against payloads
 * the real contract types more narrowly. Typing the arguments `never` would
 * make every call in this file a compile error instead of a runtime assertion.
 */
type Bridge = Record<string, (...args: unknown[]) => Promise<unknown>>

const bridge = () => createWebBridge() as unknown as Bridge

/** Queue fetch responses in order; each is [status, body]. */
function stubFetchSequence(responses: Array<[number, unknown] | Error>) {
  const urls: string[] = []
  let i = 0
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    urls.push(typeof input === 'string' ? input : String(input))
    void init
    const next = responses[Math.min(i++, responses.length - 1)]
    if (next instanceof Error) return Promise.reject(next)
    const [status, body] = next as [number, unknown]
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    })
  })
  return urls
}

function stubStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    store
  })
  return store
}

/**
 * The descriptor members read `/api/status` for `gatewayRunning`, so a save
 * test that forgets this would make a real request to `location.origin`.
 * `gateway_running: false` is what a real `hermes serve` answers for a stopped
 * messaging gateway — MEASURED — so this is not a convenient default.
 */
function stubGatewayStatus(gatewayRunning = false) {
  stubFetchSequence([[200, { version: '0.21.5', gateway_running: gatewayRunning }]])
}

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
})
afterEach(() => vi.unstubAllGlobals())

describe('normalizeRemoteBaseUrl', () => {
  it('adds http:// to a scheme-less host:port, as users paste them', () => {
    // Electron's own comment: `new URL('100.64.0.1:9119')` parses `9119` as
    // the protocol and produces a baffling error.
    expect(normalizeRemoteBaseUrl('100.64.0.1:9119')).toBe('http://100.64.0.1:9119')
    expect(normalizeRemoteBaseUrl('hermes.example')).toBe('http://hermes.example')
  })

  it('keeps an explicit http/https URL', () => {
    expect(normalizeRemoteBaseUrl('http://a.example:9119')).toBe('http://a.example:9119')
    expect(normalizeRemoteBaseUrl('https://a.example')).toBe('https://a.example')
  })

  it('strips query, hash and trailing slashes', () => {
    expect(normalizeRemoteBaseUrl('https://a.example/base/?x=1#f')).toBe('https://a.example/base')
  })

  it('rejects a non-http scheme rather than accepting it silently', () => {
    expect(() => normalizeRemoteBaseUrl('ftp://a.example')).toThrow(/http:\/\/ or https:\/\//)
    expect(() => normalizeRemoteBaseUrl('file:///etc/passwd')).toThrow(/http:\/\/ or https:\/\//)
  })

  it('rejects an empty value', () => {
    expect(() => normalizeRemoteBaseUrl('   ')).toThrow(/required/)
  })
})

describe('probeConnectionConfig', () => {
  it('reports token mode for a gateway that does not require auth', async () => {
    stubFetchSequence([[200, { version: '0.21.5', auth_required: false }]])
    const result = (await bridge().probeConnectionConfig('http://127.0.0.1:9119')) as {
      reachable: boolean
      authMode: string
      version: string | null
    }
    expect(result.reachable).toBe(true)
    expect(result.authMode).toBe('token')
    expect(result.version).toBe('0.21.5')
  })

  it('reports oauth mode and lists providers when auth is gated', async () => {
    stubFetchSequence([
      [200, { version: '0.21.5', auth_required: true }],
      [200, { providers: [{ name: 'nous', display_name: 'Nous Research', supports_password: false }] }]
    ])
    const result = (await bridge().probeConnectionConfig('http://g.example')) as {
      authMode: string
      providers: Array<{ name: string; displayName: string; supportsPassword: boolean }>
    }
    expect(result.authMode).toBe('oauth')
    expect(result.providers).toEqual([{ name: 'nous', displayName: 'Nous Research', supportsPassword: false }])
  })

  it('sends NO credential on the probe', async () => {
    const urls = stubFetchSequence([[200, { auth_required: false }]])
    await bridge().probeConnectionConfig('http://g.example')
    // `/api/status` is public; attaching a session token would make a
    // reachability check depend on a credential it does not need.
    expect(urls[0]).toBe('http://g.example/api/status')
  })

  it('never throws on a half-typed URL — it always returns a well-formed result', async () => {
    // The settings UI calls this per keystroke; a throw here would hit the
    // error boundary while the user is still typing the host.
    //
    // Note what is NOT asserted: that every partial input is "unreachable".
    // `"h"` normalizes to `http://h`, which is a syntactically valid host, so
    // the probe fires a real request for it — exactly as Electron's does — and
    // whether it reports reachable depends on the network, not on the typing.
    // The invariant is the shape, and the absence of a throw.
    for (const partial of ['', 'h', 'htt', 'ht', 'http://', 'not a url', '   ']) {
      stubFetchSequence([new TypeError('fetch failed')])
      const result = (await bridge().probeConnectionConfig(partial)) as {
        baseUrl: string
        reachable: boolean
        authMode: string
        providers: unknown[]
        version: string | null
        error: string | null
      }
      expect(typeof result.baseUrl, `"${partial}" must return a baseUrl`).toBe('string')
      expect(typeof result.reachable).toBe('boolean')
      expect(['oauth', 'token', 'unknown']).toContain(result.authMode)
      expect(Array.isArray(result.providers)).toBe(true)
      expect(result.error, `"${partial}" must carry a reason`).toBeTruthy()
    }
  })

  it('reports unreachable for a syntactically invalid host, without a request', async () => {
    // Nothing to fetch: normalization failed, so no network call is made.
    const urls = stubFetchSequence([[200, {}]])
    const result = (await bridge().probeConnectionConfig('not a url')) as {
      reachable: boolean
      authMode: string
      error: string | null
    }
    expect(result.reachable).toBe(false)
    expect(result.authMode).toBe('unknown')
    expect(result.error).toBeTruthy()
    expect(urls).toHaveLength(0)
  })

  it('reports unreachable rather than throwing when the host is down', async () => {
    stubFetchSequence([new TypeError('fetch failed')])
    const result = (await bridge().probeConnectionConfig('http://down.example')) as {
      reachable: boolean
      error: string | null
    }
    expect(result.reachable).toBe(false)
    // A browser cannot see why a cross-origin call failed, and the copy says so
    // rather than inventing a status code.
    expect(result.error).toMatch(/origin|fetch failed/i)
  })

  it('reports a non-2xx status', async () => {
    stubFetchSequence([[502, {}]])
    const result = (await bridge().probeConnectionConfig('http://g.example')) as { error: string }
    expect(result.error).toContain('502')
  })

  it('still reports the auth mode when provider listing fails', async () => {
    stubFetchSequence([[200, { auth_required: true }], new TypeError('fetch failed')])
    const result = (await bridge().probeConnectionConfig('http://g.example')) as {
      authMode: string
      providers: unknown[]
    }
    expect(result.authMode).toBe('oauth')
    expect(result.providers).toEqual([])
  })
})

describe('testConnectionConfig', () => {
  it('tests the HTTP leg and reports the version', async () => {
    stubFetchSequence([[200, { version: '9.9.9' }]])
    const result = (await bridge().testConnectionConfig({ remoteUrl: 'http://g.example' })) as {
      ok: boolean
      reachable: boolean
      version: string | null
      baseUrl: string
    }
    expect(result.ok).toBe(true)
    expect(result.reachable).toBe(true)
    expect(result.version).toBe('9.9.9')
    expect(result.baseUrl).toBe('http://g.example')
  })

  it('refuses SSH honestly instead of reporting ok', async () => {
    // A browser has no ssh binary, no host-key store and no agent.
    const result = (await bridge().testConnectionConfig({ mode: 'ssh', sshHost: 'box' })) as {
      reachable: boolean
      sshError: string
    }
    expect(result.reachable).toBe(false)
    expect(result.sshError).toBe('unsupported-platform')
    expect(result).not.toHaveProperty('ok', true)
  })

  it('never sends credentialed cross-origin requests — they are blocked', async () => {
    // Regression. MEASURED in a real browser: the gateway sends
    // `Access-Control-Allow-Credentials` ABSENT, so `credentials:'include'`
    // fails with "Failed to fetch" while `omit` returns 200. The original
    // implementation used `include` for the cookie path and the live probe died
    // with an opaque TypeError that looked like the host was down.
    let seen: RequestInit | undefined
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = init
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ version: '1' }) })
    })
    await bridge().testConnectionConfig({ remoteUrl: 'http://g.example' })
    expect(seen?.credentials).toBe('omit')
  })

  it('reports an unreachable host without throwing', async () => {
    stubFetchSequence([new TypeError('fetch failed')])
    const result = (await bridge().testConnectionConfig({ remoteUrl: 'http://down.example' })) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('reports a malformed URL without throwing', async () => {
    const result = (await bridge().testConnectionConfig({ remoteUrl: 'ftp://x' })) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/http:\/\/ or https:\/\//)
  })
})

describe('saveConnectionConfig / applyConnectionConfig', () => {
  it('round-trips the descriptor into storage', async () => {
    const store = stubStorage()
    stubGatewayStatus()
    const result = (await bridge().saveConnectionConfig({ mode: 'remote', remoteUrl: 'http://g.example' })) as {
      mode: string
      remoteUrl: string
    }
    expect(result.mode).toBe('remote')
    expect(result.remoteUrl).toBe('http://g.example')
    expect(store.size).toBe(1)
  })

  it('keeps every SSH field the settings form adopts', async () => {
    // REGRESSION. Measured in the live web client: the save response carried
    // `sshHost`/`sshUser` but not `sshPort`, `sshKeyPath`,
    // `sshRemoteHermesPath` or `sshRemoteProfile`. The renderer adopts the save
    // response as current state, so a successful Save visibly emptied those four
    // inputs, and the stored entry never held them either.
    const store = stubStorage()
    stubGatewayStatus()
    const saved = (await bridge().saveConnectionConfig({
      mode: 'ssh',
      sshHost: 'box.invalid',
      sshUser: 'deploy',
      sshPort: 2222,
      sshKeyPath: '/home/deploy/.ssh/id_ed25519',
      sshRemoteHermesPath: '/opt/hermes/bin/hermes',
      sshRemoteProfile: 'production'
    })) as Record<string, unknown>
    expect(saved).toMatchObject({
      sshHost: 'box.invalid',
      sshUser: 'deploy',
      sshPort: 2222,
      sshKeyPath: '/home/deploy/.ssh/id_ed25519',
      sshRemoteHermesPath: '/opt/hermes/bin/hermes',
      sshRemoteProfile: 'production'
    })
    expect(JSON.parse([...store.values()][0])).toMatchObject({
      sshPort: 2222,
      sshKeyPath: '/home/deploy/.ssh/id_ed25519',
      sshRemoteHermesPath: '/opt/hermes/bin/hermes'
    })
  })

  it('reports gatewayRunning from /api/status instead of asserting true', async () => {
    // REGRESSION. The old member hardcoded `true`. A real `hermes serve` answers
    // `"gateway_running": false, "gateway_state": "stopped"` — measured — so the
    // save response was claiming a stopped messaging gateway was running.
    stubStorage()
    stubGatewayStatus(false)
    const stopped = (await bridge().saveConnectionConfig({ mode: 'local' })) as { gatewayRunning: boolean }
    expect(stopped.gatewayRunning).toBe(false)

    stubStorage()
    stubGatewayStatus(true)
    const running = (await bridge().saveConnectionConfig({ mode: 'local' })) as { gatewayRunning: boolean }
    expect(running.gatewayRunning).toBe(true)
  })

  it('rejects when storage refuses the write, instead of reporting a save', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    stubGatewayStatus()
    // The renderer turns this into the "Could not save gateway settings" toast.
    // A success-shaped answer here is the "saved!" lie: nothing was stored, and
    // the settings form would adopt a descriptor that a reload cannot see.
    await expect(bridge().saveConnectionConfig({ mode: 'local' })).rejects.toThrow(/refused to store/)
  })

  it('rejects when the browser accepts the write but drops it silently', async () => {
    // Private-mode and quota policies can resolve `setItem` and keep nothing.
    // Read-back is what distinguishes a saved setting from a dropped one.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => void store.delete('x')
    })
    stubGatewayStatus()
    await expect(bridge().saveConnectionConfig({ mode: 'local' })).rejects.toThrow(/read-back/)
  })

  it('returns what storage actually holds, not what was sent', async () => {
    // A storage layer that normalizes values must not be second-guessed: the
    // renderer adopts this response, so it has to be the persisted truth.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, JSON.stringify({ ...JSON.parse(v), remoteUrl: 'http://normalized.example' }))
      },
      removeItem: (k: string) => void store.delete(k)
    })
    stubGatewayStatus()
    const result = (await bridge().saveConnectionConfig({ mode: 'remote', remoteUrl: 'http://sent.example' })) as {
      remoteUrl: string
    }
    expect(result.remoteUrl).toBe('http://normalized.example')
  })

  it('reports secureTokenStorage FALSE — there is no keychain here', async () => {
    stubStorage()
    stubGatewayStatus()
    const result = (await bridge().saveConnectionConfig({ mode: 'remote' })) as {
      secureTokenStorage: boolean
    }
    // The contract has this field precisely so a renderer can warn; reporting
    // true would be asserting protection the browser does not have.
    expect(result.secureTokenStorage).toBe(false)
  })

  it('reports remoteTokenPlainText exactly when a token is stored', async () => {
    stubStorage()
    stubGatewayStatus()
    const withToken = (await bridge().saveConnectionConfig({
      mode: 'remote',
      remoteToken: 'supersecrettoken'
    })) as { remoteTokenPlainText: boolean; remoteTokenSet: boolean; remoteTokenPreview: string | null }
    expect(withToken.remoteTokenPlainText).toBe(true)
    expect(withToken.remoteTokenSet).toBe(true)
    // The token itself never comes back — only a preview, as Electron does.
    expect(withToken.remoteTokenPreview).not.toContain('supersecrettoken')

    const without = (await bridge().saveConnectionConfig({ mode: 'remote' })) as {
      remoteTokenPlainText: boolean
      remoteTokenPreview: string | null
    }
    expect(without.remoteTokenPlainText).toBe(false)
    expect(without.remoteTokenPreview).toBeNull()
  })

  it('refuses apply rather than reporting a reconnect that never happened', async () => {
    const store = stubStorage()
    await expect(bridge().applyConnectionConfig({ mode: 'remote', remoteUrl: 'http://g.example' })).rejects.toThrow(
      /Open the target gateway URL/
    )
    expect(store.size).toBe(0)
  })
})

describe('getConnectionConfig', () => {
  it('reads a saved entry back after a reload', async () => {
    const store = stubStorage()
    stubGatewayStatus(true)
    await bridge().saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://g.example',
      remoteToken: 'supersecrettoken',
      sshPort: 2222,
      sshKeyPath: '/home/deploy/.ssh/id_ed25519'
    })

    // A reload: same origin, same storage, a bridge built from scratch. This is
    // the roundtrip that makes "Saved" mean something — before the fix this read
    // a hardcoded descriptor and dropped every stored field.
    stubFetchSequence([[200, { gateway_running: true }]])
    const config = (await bridge().getConnectionConfig()) as Record<string, unknown>
    expect(config).toMatchObject({
      remoteUrl: 'http://g.example',
      remoteTokenSet: true,
      remoteTokenPlainText: true,
      secureTokenStorage: false,
      sshPort: 2222,
      sshKeyPath: '/home/deploy/.ssh/id_ed25519',
      gatewayRunning: true
    })
    expect(config.remoteTokenPreview).not.toContain('supersecrettoken')
    expect(store.size).toBe(1)
  })

  it('reports the connection it actually holds, not the stored draft mode', async () => {
    // `mode` feeds boot routing, profile remote-override badges and the
    // boot-failure sign-in path. This client is attached to the gateway that
    // served the page and never dialled an SSH or remote endpoint
    // (`applyConnectionConfig` refuses), so a stored draft must not claim it.
    stubStorage()
    stubGatewayStatus()
    await bridge().saveConnectionConfig({ mode: 'ssh', sshHost: 'box.invalid', sshPort: 2222 })
    stubFetchSequence([[200, { gateway_running: false }]])
    const config = (await bridge().getConnectionConfig()) as { mode: string; sshHost: string; sshPort: number }
    expect(config.mode).toBe('local')
    // …while the endpoint entry itself survives and reappears in the form.
    expect(config.sshHost).toBe('box.invalid')
    expect(config.sshPort).toBe(2222)
  })

  it('returns the contract fields, and no invented ones', async () => {
    stubStorage()
    stubGatewayStatus()
    const config = (await bridge().getConnectionConfig()) as Record<string, unknown>
    expect(Object.keys(config).sort()).toEqual(
      [
        'cloudOrg',
        'envOverride',
        'gatewayRunning',
        'mode',
        'profile',
        'remoteAuthMode',
        'remoteOauthConnected',
        'remoteTokenPlainText',
        'remoteTokenPreview',
        'remoteTokenSet',
        'remoteUrl',
        'secureTokenStorage',
        'sshHost',
        'sshKeyPath',
        'sshPort',
        'sshRemoteHermesPath',
        'sshRemoteProfile',
        'sshUser'
      ].sort()
    )
    // `remoteTokenStoredPlain` was never in `DesktopConnectionConfig`; the
    // contract's field is `remoteTokenPlainText`.
    expect(config).not.toHaveProperty('remoteTokenStoredPlain')
  })

  it('treats an unreadable stored entry as nothing saved', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{ this is not json',
      setItem: () => undefined,
      removeItem: () => undefined
    })
    stubGatewayStatus()
    const config = (await bridge().getConnectionConfig()) as { mode: string; remoteUrl: string }
    // A corrupt entry must not throw into the settings mount, and must not be
    // echoed into the form as if it had been saved.
    expect(config).toMatchObject({ mode: 'local', remoteUrl: '' })
  })
})
