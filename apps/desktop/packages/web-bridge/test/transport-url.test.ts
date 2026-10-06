/**
 * URL construction in transport.ts.
 *
 * This is the regression suite for a bug that shipped and cost a full
 * debugging cycle: the socket URL was built by string interpolation, so
 * `ws://` + an `http://` origin became `ws://http://127.0.0.1:9119`, which the
 * URL parser reads with host "http". Every gateway socket then died 1006 behind
 * a "Hermes couldn't start" modal with no hint that the bridge was at fault.
 *
 * Every case here is one that a plausible-looking rewrite would break.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gatewayWsUrl, setDevGatewayOrigin, setDevSessionToken } from '../src/transport.ts'

describe('gatewaySocketUrl', () => {
  afterEach(() => {
    setDevGatewayOrigin('')
    setDevSessionToken('')
  })

  it('never produces a host named after the scheme', () => {
    // The exact failure: "ws://" + "http://host" must not become host "http".
    setDevGatewayOrigin('http://127.0.0.1:9119')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.host).toBe('127.0.0.1:9119')
      expect(url.host).not.toBe('http')
      expect(url.hostname).toBe('127.0.0.1')
      expect(url.port).toBe('9119')
      expect(url.pathname).toBe('/api/ws')
    })
  })

  it('upgrades http to ws and https to wss', () => {
    setDevGatewayOrigin('http://gateway.example:8080')
    return gatewayWsUrl()
      .then(result => {
        expect(result.wsUrl).toMatch(/^ws:\/\/gateway\.example:8080\/api\/ws/)
        setDevGatewayOrigin('https://gateway.example')
        return gatewayWsUrl()
      })
      .then(result => {
        expect(result.wsUrl).toMatch(/^wss:\/\/gateway\.example\/api\/ws/)
      })
  })

  it('tolerates a trailing slash on the override', () => {
    setDevGatewayOrigin('http://127.0.0.1:9119/')
    return gatewayWsUrl().then(result => {
      expect(result.wsUrl).toBe('ws://127.0.0.1:9119/api/ws')
    })
  })

  it('drops any query on the origin instead of inheriting it', () => {
    // An override carrying a stray query must not leak into the socket URL,
    // where it could shadow the token.
    setDevGatewayOrigin('http://127.0.0.1:9119/?stale=1')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.searchParams.get('stale')).toBeNull()
    })
  })

  it('omits the credential when no dev token is configured', () => {
    setDevGatewayOrigin('http://127.0.0.1:9119')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.searchParams.get('token')).toBeNull()
    })
  })

  it('puts the dev token in the query, because a WS upgrade cannot carry a header', () => {
    setDevGatewayOrigin('http://127.0.0.1:9119')
    setDevSessionToken('spike-token-123')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.searchParams.get('token')).toBe('spike-token-123')
      // Exactly one credential parameter: a duplicate would be ambiguous.
      expect(url.searchParams.getAll('token')).toHaveLength(1)
    })
  })

  it('encodes a credential with URL-significant characters intact', () => {
    setDevGatewayOrigin('http://127.0.0.1:9119')
    setDevSessionToken('a b&c=d#e')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.searchParams.get('token')).toBe('a b&c=d#e')
    })
  })

  it('reports ok for every origin rather than inventing a failure', () => {
    // The renderer treats !ok as a boot failure; the URL is always derivable
    // from the serving origin, so this must never be false in practice.
    setDevGatewayOrigin('http://127.0.0.1:9119')
    return gatewayWsUrl().then(result => {
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })
  })

  it('is a valid absolute ws: URL that a WebSocket would accept', () => {
    setDevGatewayOrigin('http://127.0.0.1:9119')
    return gatewayWsUrl().then(result => {
      const url = new URL(result.wsUrl!)
      expect(url.protocol).toBe('ws:')
      expect(url.pathname.startsWith('/')).toBe(true)
      // Round-trips through the URL parser unchanged.
      expect(new URL(url.toString()).toString()).toBe(url.toString())
    })
  })
})

describe('gatewayWsUrl without a dev override', () => {
  const originalLocation = globalThis.location

  beforeEach(() => {
    // Same-origin is the production configuration: the bundle is served BY the
    // gateway, so no override is set and the serving origin is the socket host.
    setDevGatewayOrigin('')
    vi.stubGlobal('location', { origin: 'https://hermes.example.com', protocol: 'https:' })
  })

  afterEach(() => {
    vi.stubGlobal('location', originalLocation)
  })

  it('is same-origin and wss under https', () => {
    return gatewayWsUrl().then(result => {
      expect(result.wsUrl).toBe('wss://hermes.example.com/api/ws')
      expect(result.wsUrl?.includes('token')).toBe(false)
    })
  })
})
