import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { LayoutTreeRoot } from './index'

// The zone shell hides the old-shell titlebar BANDS inside every zone —
// including the chat's session header (the only always-visible affordance for
// the session menu). That hide was written for the ELECTRON shell, where the
// native titlebar tab strip replaces the band. The web client (browser frame =
// the frame) has no native titlebar, so LayoutTreeRoot must inject a
// [data-web-client] override that mounts the band at the titlebar height.
// Pinned as a string because jsdom applies no stylesheets — the rule's text IS
// the contract; the live behavior is verified against the built web client.
describe('LayoutTreeRoot injected style', () => {
  afterEach(cleanup)

  it('hides old-shell titlebar bands inside zones', () => {
    render(<LayoutTreeRoot />)
    const style = [...document.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    expect(style).toContain('[data-tree-group] header[class*="h-(--titlebar-height)"]')
    expect(style).toContain('display: none')
  })

  it('re-mounts the band for the web client at the titlebar height', () => {
    render(<LayoutTreeRoot />)
    const style = [...document.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    expect(style).toContain('[data-web-client] [data-tree-group] header[class*="h-(--titlebar-height)"]')
    expect(style).toContain('display: flex')
    expect(style).toContain('height: 34px')
  })
})
