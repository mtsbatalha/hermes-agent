import { afterEach, describe, expect, it } from 'vitest'

import { isWebClient, markWebClientRoot } from './web-client'

// Contract under test: the web bridge CUTS `windowControls` from the desktop
// contract entirely (manifest kind:'cut'), while EVERY Electron window provides
// it — including plain Windows desktop, where `custom` is false (only WSLg sets
// custom:true). So web-ness is the ABSENCE of the member, never its `custom`
// flag: keying on `custom` would misread a plain Windows desktop as web.
describe('isWebClient', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-web-client')
    // @ts-expect-error test-only stub teardown
    delete window.hermesDesktop
  })

  it('is true when the bridge is the web bridge (windowControls cut)', () => {
    window.hermesDesktop = {} as typeof window.hermesDesktop
    expect(isWebClient()).toBe(true)
  })

  it('is false on a plain Electron desktop whose windowControls are not custom', () => {
    window.hermesDesktop = {
      windowControls: { close: () => {}, custom: false, minimize: () => {}, toggleMaximize: () => {} }
    } as unknown as typeof window.hermesDesktop
    expect(isWebClient()).toBe(false)
  })

  it('is false on WSLg, where the renderer draws its own window controls', () => {
    window.hermesDesktop = {
      windowControls: { close: () => {}, custom: true, minimize: () => {}, toggleMaximize: () => {} }
    } as unknown as typeof window.hermesDesktop
    expect(isWebClient()).toBe(false)
  })

  it('treats a missing bridge as web (browser-like: no Electron chrome exists)', () => {
    // No preload bridge at all means no native titlebar either — the band's
    // web override may mount. jsdom/SSR land here.
    expect(isWebClient()).toBe(true)
  })
})

describe('markWebClientRoot', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-web-client')
    // @ts-expect-error test-only stub teardown
    delete window.hermesDesktop
  })

  it('marks <html> with data-web-client so shell CSS can key on it', () => {
    window.hermesDesktop = {} as typeof window.hermesDesktop
    markWebClientRoot()
    expect(document.documentElement.getAttribute('data-web-client')).toBe('true')
  })

  it('leaves <html> unmarked under Electron', () => {
    window.hermesDesktop = {
      windowControls: { close: () => {}, custom: false, minimize: () => {}, toggleMaximize: () => {} }
    } as unknown as typeof window.hermesDesktop
    markWebClientRoot()
    expect(document.documentElement.hasAttribute('data-web-client')).toBe(false)
  })
})
