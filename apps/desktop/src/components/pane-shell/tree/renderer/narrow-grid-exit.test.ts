import { describe, expect, it } from 'vitest'

import { leavesGridOnNarrow } from './track-model'

// Ground truth for "the docked terminal is unusable on a phone": a bottom tool
// deck has to leave the grid on a narrow viewport and come back as a bottom
// sheet, the same way a collapsible rail leaves and comes back as an edge
// overlay. `leavesGridOnNarrow` is the ONE predicate every site reads
// (tree-split's paneGone, tree-group's paneShown, the tab strip, the overlay),
// so they cannot disagree about which panes are on screen.

describe('leavesGridOnNarrow', () => {
  it('keeps an ordinary pane in the grid', () => {
    const rightRail = { placement: 'right', width: '237px' }

    expect(leavesGridOnNarrow({})).toBe(false)
    expect(leavesGridOnNarrow({ placement: 'main' })).toBe(false)
    expect(leavesGridOnNarrow(rightRail)).toBe(false)
  })

  it('treats a collapsible rail as leaving the grid', () => {
    expect(leavesGridOnNarrow({ collapsible: true, placement: 'left' })).toBe(true)
    expect(leavesGridOnNarrow({ collapsible: true, placement: 'right' })).toBe(true)
  })

  it('treats a bottom tool deck as leaving the grid', () => {
    // The docked deck of the DEFAULT tree is the bottom of the RIGHT column.
    // Once the collapsible rails leave the grid the deck is alone in a column
    // squeezed to a sliver — measured 53x99px / `RESIZE:6;6` at 390x844, about
    // six columns, where a 23-character TUI line can never echo back. It is
    // NOT marked collapsible (its collapse semantics are the zone rail, not an
    // overlay), so placement is what has to speak here.
    const deckChrome = { height: '20vh', placement: 'bottom' }

    expect(leavesGridOnNarrow(deckChrome)).toBe(true)
  })
})
