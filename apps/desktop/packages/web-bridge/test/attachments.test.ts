/**
 * File attachments: `readFileDataUrl`, `readFileDataUrlForAttach`,
 * `dataUrlReadMax`.
 *
 * The highest-traffic unported member in the renderer (38 call sites across 14
 * files), so its contract is worth pinning precisely. Two things are easy to get
 * wrong and invisible until a user attaches a file:
 *
 *   1. The route answers `{"dataUrl": "…"}` — an OBJECT. The contract promises a
 *      bare string, so it must be unwrapped.
 *   2. A missing file must NOT reject. `HermesReadFileErrorResult` exists
 *      because a restored preview tab pointing at a deleted file is an expected
 *      outcome the renderer already draws; throwing turns it into an unhandled
 *      rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWebBridge, IMPLEMENTED_MEMBERS } from '../src/index.ts'

type Bridge = ReturnType<typeof createWebBridge> & {
  readFileDataUrl: (p: string) => Promise<unknown>
  readFileDataUrlForAttach: (p: string) => Promise<unknown>
  dataUrlReadMax: {
    get: () => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
    set: (mb: number) => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
  }
}

function bridge(): Bridge {
  return createWebBridge() as Bridge
}

/** Stub fetch with a chosen status and body; returns the recorded calls. */
function stubFetch(status: number, body: string) {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : String(input))
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) })
  })
  return calls
}

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('readFileDataUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is a live member', () => {
    expect(IMPLEMENTED_MEMBERS).toContain('readFileDataUrl')
    expect(IMPLEMENTED_MEMBERS).toContain('readFileDataUrlForAttach')
    expect(IMPLEMENTED_MEMBERS).toContain('dataUrlReadMax')
  })

  it('unwraps the object the route returns into a bare string', async () => {
    // The route answers {"dataUrl": …}; the contract promises Promise<string>.
    // Returning the object would put "[object Object]" in an <img src>.
    const calls = stubFetch(200, JSON.stringify({ dataUrl: DATA_URL }))
    const result = await bridge().readFileDataUrl('/tmp/a.png')
    expect(result).toBe(DATA_URL)
    expect(calls[0]).toContain('/api/fs/read-data-url?path=')
  })

  it('encodes a path with spaces, hashes and non-ASCII', async () => {
    const calls = stubFetch(200, JSON.stringify({ dataUrl: DATA_URL }))
    await bridge().readFileDataUrl('C:/Users/Mateus/My Docs/a#1 ünïcode.png')
    const path = new URL(calls[0], 'http://x').searchParams.get('path')
    expect(path).toBe('C:/Users/Mateus/My Docs/a#1 ünïcode.png')
    // A raw '#' would truncate the query at the fragment.
    expect(calls[0]).not.toMatch(/path=[^&]*#/)
  })

  it('returns the structured result for a missing file instead of rejecting', async () => {
    // 404 measured: {"detail":"File not found"}
    stubFetch(404, JSON.stringify({ detail: 'File not found' }))
    const result = (await bridge().readFileDataUrl('/gone/missing.png')) as {
      ok: false
      error: string
      message: string
      path: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ENOENT')
    expect(result.message).toBeTruthy()
    expect(result.path).toBe('/gone/missing.png')
  })

  it('reports an over-cap file as a limit, not a fault', async () => {
    // 413 measured: files.py raises "File too large" over the server cap.
    stubFetch(413, JSON.stringify({ detail: 'File too large' }))
    const result = (await bridge().readFileDataUrl('/tmp/huge.bin')) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('EFBIG')
  })

  it('throws on a genuine server fault rather than dressing it as "missing"', async () => {
    // A 500 must not render as "preview unavailable" — that hides a real fault
    // behind an expected state.
    stubFetch(500, 'boom')
    await expect(bridge().readFileDataUrl('/tmp/a.png')).rejects.toThrow(/500/)
  })

  it('throws when a 200 arrives with no dataUrl field', async () => {
    // Returning undefined would be the placeholder bug in a new coat.
    stubFetch(200, JSON.stringify({}))
    await expect(bridge().readFileDataUrl('/tmp/a.png')).rejects.toThrow(/without a dataUrl/)
  })

  it('ForAttach hits the same route and does not claim a bigger cap', async () => {
    // Electron reads 256 MiB locally for attach; here the SERVER enforces the
    // cap, so claiming more would promise an attachment the gateway rejects.
    const calls = stubFetch(200, JSON.stringify({ dataUrl: DATA_URL }))
    const result = await bridge().readFileDataUrlForAttach('/tmp/a.png')
    expect(result).toBe(DATA_URL)
    expect(calls[0]).toContain('/api/fs/read-data-url')
  })

  it('returns a missing-file result for the attach path too', async () => {
    stubFetch(404, JSON.stringify({ detail: 'File not found' }))
    const result = (await bridge().readFileDataUrlForAttach('/gone.png')) as { ok: boolean }
    expect(result.ok).toBe(false)
  })
})

describe('dataUrlReadMax', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
    vi.stubGlobal('localStorage', {
      store: new Map<string, string>(),
      getItem: (k: string) => (globalThis.localStorage as never as { store: Map<string, string> }).store.get(k) ?? null,
      setItem: (k: string, v: string) =>
        (globalThis.localStorage as never as { store: Map<string, string> }).store.set(k, v)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to the shared default, and reports the server cap', async () => {
    const result = await bridge().dataUrlReadMax.get()
    // 16 comes from @hermes/shared, the same constant the renderer's Settings
    // clamp uses — imported, not restated, so the two cannot drift.
    expect(result.defaultMaxMb).toBe(16)
    expect(result.maxMb).toBe(16)
    expect(result.maxBytes).toBe(16 * 1024 * 1024)
  })

  it('maxBytes matches the gateway, not the client preference', async () => {
    await bridge().dataUrlReadMax.set(64)
    const result = await bridge().dataUrlReadMax.get()
    expect(result.maxMb).toBe(64)
    // Raising the local preference cannot raise what the server accepts.
    expect(result.maxBytes).toBe(16 * 1024 * 1024)
  })

  it('round-trips a set through storage', async () => {
    await bridge().dataUrlReadMax.set(32)
    expect((await bridge().dataUrlReadMax.get()).maxMb).toBe(32)
  })

  it('clamps below the shared minimum', async () => {
    expect((await bridge().dataUrlReadMax.set(0)).maxMb).toBe(1)
    expect((await bridge().dataUrlReadMax.set(-5)).maxMb).toBe(1)
  })

  it('clamps above the shared maximum', async () => {
    // 4096 is DATA_URL_READ_MAX_MAX_MB. A value beyond it is a UI bug or a
    // hand-edited value; it must not be stored as-is.
    expect((await bridge().dataUrlReadMax.set(999_999)).maxMb).toBe(4096)
  })

  it('falls back to the default for a corrupt stored value', async () => {
    const store = (globalThis.localStorage as never as { store: Map<string, string> }).store
    store.set('hermes.web.dataUrlReadMaxMb', 'not-a-number')
    expect((await bridge().dataUrlReadMax.get()).maxMb).toBe(16)
  })

  it('still answers when storage is unavailable', async () => {
    // Private mode / storage disabled must not throw: the default is a real answer.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    expect((await bridge().dataUrlReadMax.get()).maxMb).toBe(16)
    expect((await bridge().dataUrlReadMax.set(64)).maxMb).toBe(64)
  })
})
