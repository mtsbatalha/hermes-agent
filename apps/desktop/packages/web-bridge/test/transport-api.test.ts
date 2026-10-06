/**
 * The REST funnel: scope handling, headers, uploads, and error attribution.
 *
 * The scope bug from the spike is the reason this file exists. The renderer
 * passes `null`/`undefined` for the primary profile, and interpolating that
 * into the query produced the literal string "undefined" — which became the
 * composite scope `undefined::default` and stopped the composer ever
 * submitting. A "fix" that logs instead of dropping it would look fine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, BridgeError, setDevSessionToken } from '../src/transport.ts'

type FetchArgs = { url: string; init: RequestInit }

/** Stub fetch and hand back the calls so the URL can be asserted on. */
function stubFetch(ok = true, body = '{"ok":true}', status = 200) {
  const calls: FetchArgs[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return Promise.resolve({
      ok,
      status,
      text: () => Promise.resolve(body)
    } as Response)
  })
  return calls
}

describe('api() profile scoping', () => {
  beforeEach(() => {
    setDevSessionToken('')
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setDevSessionToken('')
  })

  it('omits the scope for the primary profile', () => {
    const calls = stubFetch()
    return api('/api/fs/list', {}, 'readDir').then(() => {
      expect(calls[0].url).toBe('/api/fs/list')
      expect(calls[0].url).not.toContain('profile')
      expect(calls[0].url).not.toContain('undefined')
    })
  })

  it('never emits the string "undefined" for a nullish or empty profile', async () => {
    // The regression this whole file is named for.
    for (const profile of [null, undefined, '']) {
      const calls = stubFetch()
      await api('/api/fs/list', { profile }, 'readDir')
      expect(calls[0].url).toBe('/api/fs/list')
      vi.unstubAllGlobals()
    }
  })

  it('scopes a real profile', () => {
    const calls = stubFetch()
    return api('/api/fs/list', { profile: 'work' }, 'readDir').then(() => {
      expect(calls[0].url).toBe('/api/fs/list?profile=work')
    })
  })

  it('escapes a profile with URL-significant characters', () => {
    const calls = stubFetch()
    return api('/api/fs/list', { profile: 'a b&c' }, 'readDir').then(() => {
      expect(calls[0].url).toBe('/api/fs/list?profile=a%20b%26c')
    })
  })

  it('appends with & when the path already carries a query', () => {
    const calls = stubFetch()
    return api('/api/fs/list?path=%2Ftmp', { profile: 'work' }, 'readDir').then(() => {
      expect(calls[0].url).toBe('/api/fs/list?path=%2Ftmp&profile=work')
      // Must not produce a second "?" that would truncate the query.
      expect(calls[0].url.split('?')).toHaveLength(2)
    })
  })
})

describe('api() request shape', () => {
  beforeEach(() => {
    setDevSessionToken('')
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setDevSessionToken('')
  })

  it('defaults to GET with no body', () => {
    const calls = stubFetch()
    return api('/api/status', {}, 'getVersion').then(() => {
      expect(calls[0].init.method).toBe('GET')
      expect(calls[0].init.body).toBeUndefined()
    })
  })

  it('serializes a JSON body with the right content type', () => {
    const calls = stubFetch()
    return api('/api/fs/write-text', { method: 'POST', body: { cwd: '/tmp' } }, 'writeTextFile').then(() => {
      expect(calls[0].init.method).toBe('POST')
      expect(calls[0].init.body).toBe('{"cwd":"/tmp"}')
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    })
  })

  it('sends the dev session token only when one is configured', async () => {
    const bare = stubFetch()
    await api('/api/status', {}, 'getVersion')
    expect((bare[0].init.headers as Record<string, string>)['X-Hermes-Session-Token']).toBeUndefined()

    vi.unstubAllGlobals()
    setDevSessionToken('spike-token-123')
    const withToken = stubFetch()
    await api('/api/status', {}, 'getVersion')
    expect((withToken[0].init.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('spike-token-123')
  })

  it('always asks for same-origin credentials', () => {
    const calls = stubFetch()
    return api('/api/status', {}, 'getVersion').then(() => {
      expect(calls[0].init.credentials).toBe('same-origin')
    })
  })

  it('uploads a file as multipart, not as a JSON string', () => {
    const calls = stubFetch()
    return api(
      '/api/fs/upload',
      { method: 'POST', upload: { filename: 'a.txt', contentType: 'text/plain', bytes: new ArrayBuffer(3) } },
      'upload'
    ).then(() => {
      expect(calls[0].init.body).toBeInstanceOf(FormData)
      // A multipart body must NOT carry a JSON content-type, or the boundary
      // is lost and the server cannot parse it.
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    })
  })

  it('returns undefined for an empty 200 rather than throwing on JSON.parse', () => {
    stubFetch(true, '')
    return api('/api/fs/write-text', { method: 'POST', body: {} }, 'writeTextFile').then(value => {
      expect(value).toBeUndefined()
    })
  })

  it('returns the parsed body on success', () => {
    stubFetch(true, '{"profiles":["a","b"]}')
    return api('/api/profiles', {}, 'getProfileRoutes').then(value => {
      expect(value).toEqual({ profiles: ['a', 'b'] })
    })
  })
})

describe('api() failures', () => {
  beforeEach(() => {
    setDevSessionToken('')
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setDevSessionToken('')
  })

  it('throws a BridgeError naming the member, the request and the status', () => {
    stubFetch(false, 'SSH ownership is not active', 404)
    return api('/api/ssh/ownership', {}, 'sshOwnership').then(
      () => expect.unreachable('should have thrown'),
      error => {
        expect(error).toBeInstanceOf(BridgeError)
        expect(error.member).toBe('sshOwnership')
        expect(error.detail).toContain('GET /api/ssh/ownership')
        expect(error.detail).toContain('404')
        expect(error.detail).toContain('SSH ownership is not active')
        expect(error.message).toContain('sshOwnership')
      }
    )
  })

  it('is catchable as a plain Error', () => {
    stubFetch(false, 'nope', 500)
    return api('/api/status', {}, 'getVersion').then(
      () => expect.unreachable('should have thrown'),
      error => {
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe('BridgeError')
      }
    )
  })

  it('truncates a huge error body so the message stays readable', () => {
    stubFetch(false, 'x'.repeat(10_000), 500)
    return api('/api/status', {}, 'getVersion').then(
      () => expect.unreachable('should have thrown'),
      error => {
        expect(error.detail.length).toBeLessThan(400)
      }
    )
  })
})

describe('BridgeError', () => {
  it('keeps member and detail as separate fields for programmatic use', () => {
    const error = new BridgeError('readDir', 'GET /api/fs/list -> 404')
    expect(error.member).toBe('readDir')
    expect(error.detail).toBe('GET /api/fs/list -> 404')
    expect(String(error)).toContain('readDir')
  })

  it('preserves an explicit cause', () => {
    const cause = new Error('socket hang up')
    expect(new BridgeError('terminal', 'PTY upgrade failed', { cause }).cause).toBe(cause)
  })
})
