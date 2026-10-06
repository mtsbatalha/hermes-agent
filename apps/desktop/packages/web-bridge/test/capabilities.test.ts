/**
 * The bridge's own invariants.
 *
 * These are the claims the UI makes decisions on, so they are asserted here
 * rather than trusted: a member is implemented if and only if it is on the
 * object, every declared member is accounted for exactly once, and cuts are
 * absent (so the renderer's own `?.` guard fires) rather than present-and-broken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BRIDGE_LEDGER, BRIDGE_STATUS, capabilities, createWebBridge, IMPLEMENTED_MEMBERS } from '../src/index.ts'
import { CAPABILITY_SURFACES } from '../src/unsupported.ts'

/** The 157 top-level members declared in src/global.d.ts, by contract name. */
const DECLARED_COUNT = 157

describe('IMPLEMENTED_MEMBERS', () => {
  it('is derived from the object, so it cannot drift', () => {
    // The failure this guards: a hand-maintained list kept naming a member the
    // object had lost, and the audit read it as implemented.
    expect([...IMPLEMENTED_MEMBERS].sort()).toEqual(Object.keys(createWebBridge()).sort())
  })

  it('contains no duplicate names', () => {
    expect(new Set(IMPLEMENTED_MEMBERS).size).toBe(IMPLEMENTED_MEMBERS.length)
  })

  it('is frozen, so nothing downstream can extend it at runtime', () => {
    expect(Object.isFrozen(IMPLEMENTED_MEMBERS)).toBe(true)
  })

  it('declares only members the contract knows', () => {
    for (const name of IMPLEMENTED_MEMBERS) {
      expect(BRIDGE_STATUS[name], `${name} is implemented but absent from the manifest`).toBeDefined()
    }
  })
})

describe('the bridge object', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
    vi.stubGlobal('window', globalThis.window ?? {})
  })

  afterEach(() => vi.unstubAllGlobals())

  it('has no key whose value is undefined', () => {
    // The placeholder shape, in disguise: the key answers `in` and a key
    // count while the call returns nothing. settings.pickDefaultProjectDir
    // shipped this way once.
    const offenders: string[] = []
    const walk = (value: unknown, path: string, depth: number): void => {
      if (depth > 3 || value === null || typeof value !== 'object') return
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const child = (value as Record<string, unknown>)[key]
        if (child === undefined) offenders.push(path ? `${path}.${key}` : key)
        else if (typeof child === 'object') walk(child, path ? `${path}.${key}` : key, depth + 1)
      }
    }
    walk(createWebBridge(), '', 0)
    expect(offenders).toEqual([])
  })

  it('is not a Proxy that answers yes to everything', () => {
    const bridge = createWebBridge() as Record<string, unknown>
    expect(bridge.api).toBeDefined()
    // A `has` trap returning true for everything is what made the renderer
    // pick a routing branch on a capability that did not exist.
    expect('definitely_not_a_member_xyz' in bridge).toBe(false)
    expect('hud' in bridge).toBe(false)
    expect('openWindow' in bridge).toBe(false)
  })

  it('leaves cut members genuinely absent so `?.` guards fire', () => {
    const bridge = createWebBridge() as Record<string, unknown>
    for (const name of ['hud', 'openWindow', 'minimizeToTray', 'relaunchApp', 'agentPluginsRoot', 'getSyncStatus']) {
      expect(name in bridge, `${name} must be absent`).toBe(false)
      expect(bridge[name]).toBeUndefined()
    }
  })

  it('implements every member the renderer calls unguarded at module load', () => {
    // These four are called without a guard during import. A cut here throws
    // before the app ever renders, which is how the first real run failed.
    const bridge = createWebBridge() as Record<string, unknown>
    for (const name of ['onBackendExit', 'onBootstrapEvent', 'getBootstrapState', 'getBootProgress']) {
      expect(typeof bridge[name], `${name} must exist`).toBe('function')
    }
  })

  it('returns a working unsubscribe from every event member', () => {
    const bridge = createWebBridge() as Record<string, (cb: (payload: unknown) => void) => () => void>
    const unsub = bridge.onBackendExit(() => undefined)
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
    unsub()
  })
})

describe('capabilities()', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5176', protocol: 'http:' })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('accounts for every declared member exactly once', () => {
    const caps = capabilities()
    expect(caps.bridge.length + caps.missing.length).toBe(DECLARED_COUNT)
    // No overlap: a member cannot be both live and missing.
    const overlap = caps.bridge.filter(name => caps.missing.includes(name))
    expect(overlap).toEqual([])
  })

  it('reports missing members with Set semantics, not `in`', () => {
    // `name in someSet` tests object PROPERTIES, so it reported all 157 as
    // missing — and would have called a bare `constructor` implemented.
    const caps = capabilities()
    expect(caps.missing).not.toContain('constructor')
    expect(caps.missing).not.toContain('toString')
    expect(caps.missing.length).toBeLessThan(DECLARED_COUNT)
  })

  it('classifies every live member as a transport or a browser API', () => {
    const caps = capabilities()
    for (const name of caps.bridge) {
      expect(['transport', 'browser']).toContain(caps.kindOf(name))
    }
  })

  it('classifies every missing member as a cut', () => {
    const caps = capabilities()
    for (const name of caps.missing) {
      expect(caps.kindOf(name)).toBe('cut')
    }
  })

  it('never calls a live member a cut, and never a cut live', () => {
    const caps = capabilities()
    const contradictions = caps.bridge.filter(name => caps.kindOf(name) === 'cut')
    expect(contradictions).toEqual([])
  })

  it('gives every cut user-facing copy, never an empty stub message', () => {
    for (const [name, record] of Object.entries(BRIDGE_STATUS)) {
      if (record.kind !== 'cut') continue
      expect(record.copy, `${name} has no copy`).toBeTruthy()
      expect(record.copy!.trim().length, `${name} has empty copy`).toBeGreaterThan(0)
    }
  })

  it('names an endpoint for every implemented member', () => {
    for (const name of IMPLEMENTED_MEMBERS) {
      const record = BRIDGE_STATUS[name]
      expect(record.endpoint, `${name} claims to work but names nothing`).toBeTruthy()
    }
  })
})

describe('the generated ledger', () => {
  it('lists every declared member in declaration order, without duplicates', () => {
    expect(BRIDGE_LEDGER).toHaveLength(DECLARED_COUNT)
    expect(new Set(BRIDGE_LEDGER).size).toBe(DECLARED_COUNT)
  })

  it('has a status record for every ledger entry', () => {
    for (const name of BRIDGE_LEDGER) {
      expect(BRIDGE_STATUS[name], `${name} has no manifest record`).toBeDefined()
    }
  })

  it('has no status record for anything the ledger does not list', () => {
    const listed = new Set(BRIDGE_LEDGER)
    const orphans = Object.keys(BRIDGE_STATUS).filter(name => !listed.has(name))
    expect(orphans).toEqual([])
  })
})

describe('CAPABILITY_SURFACES', () => {
  it('gives every unavailable surface an honest reason', () => {
    for (const surface of CAPABILITY_SURFACES) {
      if (surface.available) continue
      expect(surface.unavailableReason, `${surface.name} is unavailable with no reason`).toBeTruthy()
      expect(surface.unavailableReason!.trim().length).toBeGreaterThan(0)
    }
  })

  it('does not attach a reason to an available surface', () => {
    for (const surface of CAPABILITY_SURFACES) {
      if (!surface.available) continue
      expect(surface.unavailableReason).toBeUndefined()
    }
  })
})
