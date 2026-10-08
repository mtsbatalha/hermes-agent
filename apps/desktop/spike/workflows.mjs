/** Real-user workflow checks against the web spike, not route-load coverage. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

// `--viewport 390x844` runs the SAME scenarios at a phone-shaped viewport;
// default is the desktop shape the suite was first written against. Only the
// settings-nav path differs between the two shapes — see openSettingsSection.
const vpIndex = process.argv.indexOf('--viewport')
const vpRaw =
  vpIndex !== -1 ? process.argv[vpIndex + 1] : process.argv.find(a => a.startsWith('--viewport='))?.split('=')[1]
const [vpW, vpH] = vpRaw ? vpRaw.split('x').map(Number) : [1280, 900]
const viewport = { width: vpW || 1280, height: vpH || 900 }

const base = process.env.WEB_SPIKE_URL ?? 'http://127.0.0.1:5176/spike.html'
const artifacts = 'spike/artifacts/workflows'
mkdirSync(artifacts, { recursive: true })
const browsers = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright')
const executablePath = existsSync(browsers)
  ? readdirSync(browsers)
      .flatMap(dir => [
        path.join(browsers, dir, 'chrome-win', 'chrome.exe'),
        path.join(browsers, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
      ])
      .find(existsSync)
  : undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
// Chat view may not auto-open on boot (sticky pending session lands on the
// overview) — same rescue a user performs: open the most recent session row
// (NOT "New session": a draft has no session menu and the chat header —
// where SessionActionsMenu mounts — doesn't render at all).
async function ensureChatOpen() {
  const composer = page.locator('[data-slot="composer-rich-input"]').first()
  const deadline = Date.now() + 45_000
  let ready = false
  while (Date.now() < deadline) {
    if (await composer.isVisible().catch(() => false)) {
      ready = true
      break
    }
    await page.waitForTimeout(1000)
  }
  if (!ready) {
    // Sidebar rows are real buttons with the session title as text; pick the
    // first under the SESSIONS section.
    const row = page.locator('button.block.w-full.text-left').first()
    if (await row.count()) {
      await row.click({ timeout: 30_000 })
    } else {
      await page
        .getByRole('button', { name: 'New session' })
        .first()
        .click({ timeout: 30_000 })
        .catch(() => undefined)
    }
  }
  await composer.waitFor({ timeout: 45_000 })
  const settle = Date.now() + 20_000
  while (Date.now() < settle) {
    const ph = await composer.getAttribute('data-placeholder').catch(() => null)
    if (ph && !/Reconnecting|Starting Hermes/i.test(ph)) return
    await page.waitForTimeout(1000)
  }
}
// 4x2 red pixel — a REAL, decodable PNG (canvas-encoded), so clipboard.write
// can decode it and image chips actually render. The previous constant was an
// undecodable blob: clipboard.write decodes on write and rejected it with
// DataError, and the chip's <img> never painted. Use in the paste flows, so
// the wire assertions compare against a KNOWN payload.
const PNG_BYTES = Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAAXNSR0IArs4c6QAAABNJREFUGFdj/M/A8J8BCTCiCwAAW/kD/66aY68AAAAASUVORK5CYII=',
    'base64'
  )
)
const page = await browser.newPage({ viewport })
await page.addInitScript(() => {
  window.__ptyProbe = { receivedBytes: 0, sent: [], closed: 0, deliveredBytes: 0, output: '' }
  // Outbound prompt frames from the gateway socket — the attachment-turn check
  // asserts on what was ACTUALLY submitted, not on what the composer showed.
  window.__submits = []
  // Frames RECEIVED from the gateway (queue of strings) — outbound captures
  // can't see RPC RESULTS, and attach assertions must see attached:true.
  window.__gwrecv = []
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args)
      if (!new URL(args[0]).pathname.endsWith('/api/pty')) {
        // ONE message listener per socket — adding it inside send() would pile
        // up duplicates and flood the ring out of its newest frames. The client
        // opens MULTIPLE sockets (id channels, idle, session) — attach replies
        // can come through ANY of them, so every non-pty one feeds the ring.
        this.addEventListener('message', event => {
          window.__gwrecv.push(String(event.data))
          if (window.__gwrecv.length > 400) window.__gwrecv.splice(0, window.__gwrecv.length - 400)
        })
        const send = this.send.bind(this)
        this.send = data => {
          const frame = String(data)
          if ((frame.includes('prompt.submit') || frame.includes('image.attach')) && window.__submits.length < 200)
            window.__submits.push(frame)
          return send(data)
        }
        return
      }
      this.addEventListener('message', event => {
        window.__ptyProbe.receivedBytes +=
          typeof event.data === 'string' ? event.data.length : (event.data.byteLength ?? event.data.size ?? 0)
      })
      this.addEventListener('close', () => window.__ptyProbe.closed++)
      const send = this.send.bind(this)
      this.send = data => {
        window.__ptyProbe.sent.push(String(data))
        return send(data)
      }
    }
  }
  let bridge
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    get: () => bridge,
    set: next => {
      bridge = next
      const subscribe = next.terminal.onData.bind(next.terminal)
      next.terminal.onData = (id, callback) =>
        subscribe(id, chunk => {
          window.__ptyProbe.deliveredBytes += chunk.length
          window.__ptyProbe.output += chunk
          callback(chunk)
        })
    }
  })
})
const faults = []
const requests = []
// Chromium gates navigator.clipboard on document focus + permissions even in
// headless; playwright's default context ships NONE, so grant once.
const context = page.context()
context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
// Keep a SHORT stack with the message: 'e.trim is not a function' alone
// points nowhere — the frame that called it does.
page.on('pageerror', error =>
  faults.push(`${error.message} @ ${(error.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 300)}`)
)
page.on('response', response => {
  const url = new URL(response.url())
  if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, status: response.status() })
})
const results = []
async function check(name, run) {
  const from = faults.length
  try {
    const detail = await run()
    assert.deepEqual(faults.slice(from), [], 'Unhandled renderer faults')
    results.push({ name, status: 'passed', detail })
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message, faults: faults.slice(from) })
    await page.screenshot({ path: `${artifacts}/${name}.png` })
  }
  console.log(`${results.at(-1).status.toUpperCase()} ${name}: ${JSON.stringify(results.at(-1))}`)
}
// Turn-settle observation that CANNOT miss its window: the Stop button is
// sampled inside the page from BEFORE the submit, so a turn that starts and
// finishes while the test is still asserting on attach frames is recorded
// anyway. The older pattern (start polling in the test AFTER those asserts)
// reported a false "never settled" whenever the turn had already finished by
// the first poll — which is what the image scenarios hit for real.
async function startStopProbe() {
  await page.evaluate(() => {
    clearInterval(window.__stopTimer)
    window.__stopProbe = { seen: 0, cleared: 0, present: false }
    window.__stopTimer = setInterval(() => {
      const present = Boolean(document.querySelector('button[aria-label="Stop"]'))
      if (present) window.__stopProbe.seen += 1
      else if (window.__stopProbe.present) window.__stopProbe.cleared += 1
      window.__stopProbe.present = present
    }, 100)
  })
}
async function assertTurnSettled(label, budgetMs = 180_000) {
  const deadline = Date.now() + budgetMs
  let probe = await page.evaluate(() => ({ ...window.__stopProbe }))
  while (Date.now() < deadline) {
    probe = await page.evaluate(() => ({ ...window.__stopProbe }))
    if (probe.seen > 0 && !probe.present) break
    await page.waitForTimeout(500)
  }
  assert.ok(
    probe.seen > 0 && !probe.present,
    `${label} must settle (Stop seen, then cleared) — observed ${JSON.stringify(probe)}: ${
      probe.seen === 0 ? 'the turn never looked busy' : 'it was still busy at the deadline'
    }`
  )
  return probe
}

// Settings nav, the one control that changes shape with the viewport. Above
// 47.5rem (760px) OverlayNav renders every section as its own rail button;
// below it the SAME nav collapses into a single TabDropdown trigger and the
// sections move into its menu. Both paths call group.onSelect, so the section
// that opens is identical — only the walk to the row differs. Breakpoint from
// RAIL_HIDDEN/BAR_HIDDEN in app/overlays/overlay-split-layout.tsx; the menu row
// is a DropdownMenuItem, i.e. role=menuitem with the section label.
const NARROW_NAV = viewport.width < 760
async function openSettingsSection(label) {
  if (!NARROW_NAV) {
    await page.getByRole('button', { name: label, exact: true }).click()
    return
  }
  // One dropdown trigger exists in the overlay (the collapsed nav); the
  // settings form's own selects are comboboxes, not menu triggers.
  await page.locator('[data-slot="dropdown-menu-trigger"]:has(.codicon-chevron-down)').first().click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

// A concurrent Hermes installation can park a refusal toast behind collapsed
// notifications ('Show N more') — expand first so the check sees refusal copy
// a user would also have to expand to read. No-op when nothing is collapsed.
async function expandNotifications() {
  const more = page.getByText('more notification', { exact: false })
  if (await more.count()) await more.first().click({ timeout: 8000 })
}

// Sessions sidebar, the other control that changes shape with the viewport.
// `sessions` is collapsible, so below 47.5rem it leaves the grid entirely
// (tree-group.tsx drops collapsible panes on narrow) and is revealed as a
// pinned edge OVERLAY instead (renderer/narrow-overlays.tsx). Its session rows
// are not in the DOM until that overlay mounts, so at 390x844 every sidebar
// interaction below has to reveal it first — and the composer sits underneath
// the overlay (260px of a 390px viewport), so seeding a session has to dismiss
// it again. The titlebar button routes through toggleSidebarOpen →
// revealNarrowPane (store/layout.ts), i.e. a real toggle; Escape closes it as
// the top escape layer. No-ops above the breakpoint, where the sidebar is
// docked and always present.
async function setNarrowSidebar(open) {
  if (!NARROW_NAV) {
    return
  }

  const overlay = page.locator('[data-narrow-overlay="sessions"]')

  if (open === (await overlay.count()) > 0) {
    return
  }

  if (open) {
    // Label flips with the left edge's open flag, so match either wording.
    await page
      .getByRole('button', { name: /^(Show|Hide) sidebar$/ })
      .first()
      .click()
    await overlay.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(500)

    return
  }

  await page.keyboard.press('Escape')
  await overlay.waitFor({ state: 'detached', timeout: 15_000 })
}

try {
  await page.goto(base)
  await page.locator('[aria-label="Message"]').waitFor({ timeout: 45_000 })
  await ensureChatOpen()
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[aria-label="Message"]')
      return (
        input?.getAttribute('data-placeholder') &&
        !/Reconnecting|Starting Hermes/i.test(input.getAttribute('data-placeholder'))
      )
    },
    undefined,
    { timeout: 90_000 }
  )

  await check('logs-capability', async () => {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click()
    await openSettingsSection('Gateways')
    assert.equal(
      await page.getByRole('button', { name: 'Open logs', exact: true }).count(),
      0,
      'Do not offer native file-manager actions without the capability.'
    )
    assert.equal(
      await page.getByText('Encrypt saved secrets with the OS keychain', { exact: true }).count(),
      0,
      'Do not offer keychain encryption without the capability.'
    )
    return 'Native log reveal and keychain controls are not offered when unsupported.'
  })

  await check('connection-apply', async () => {
    await page.getByRole('button', { name: 'Save and reconnect', exact: true }).click()
    await expandNotifications()
    await page
      .getByText('Switching gateways is not supported in this web client yet. Open the target gateway URL instead.', {
        exact: false
      })
      .waitFor({ timeout: 5000 })
    return 'Unsupported reconnect is rejected visibly instead of announcing success.'
  })
  await check('connection-persistence', async () => {
    // The settings form adopts whatever the save returns, so "Saved" has to mean
    // the fields are still there — and still there after a reload. Before the
    // fix, sshPort/sshKeyPath/sshRemoteHermesPath/sshRemoteProfile were missing
    // from the save response and from storage: the save succeeded, the toast
    // played, and three of the five inputs emptied in front of the user.
    const key = 'hermes.web.connectionConfig'
    const previous = await page.evaluate(k => window.localStorage.getItem(k), key)
    const rowInput = label =>
      page
        .locator('div.grid')
        .filter({ has: page.getByText(label, { exact: true }) })
        .last()
        .locator('input')
        .first()
    const readForm = async () => ({
      host: await rowInput('Host').inputValue(),
      user: await rowInput('User').inputValue(),
      port: await rowInput('Port').inputValue(),
      key: await rowInput('Identity file').inputValue(),
      hermesPath: await rowInput('Hermes path (optional)').inputValue()
    })
    const probe = {
      host: 'workflow-box.invalid',
      user: 'workflow',
      port: '2299',
      key: '/home/workflow/.ssh/id_ed25519',
      hermesPath: '/opt/hermes/bin/hermes'
    }
    try {
      await page.getByRole('button', { name: 'Connect via SSH', exact: false }).click()
      await rowInput('Host').fill(probe.host)
      await rowInput('User').fill(probe.user)
      await rowInput('Port').fill(probe.port)
      await rowInput('Identity file').fill(probe.key)
      await rowInput('Hermes path (optional)').fill(probe.hermesPath)
      await page.getByRole('button', { name: 'Save for next restart', exact: true }).click()
      await page.getByText('Gateway settings saved', { exact: true }).waitFor({ timeout: 5000 })
      assert.deepEqual(await readForm(), probe, 'A successful save must not empty the fields it was given.')

      await page.reload()
      await page.getByRole('button', { name: 'Connect via SSH', exact: false }).waitFor({ timeout: 90_000 })
      const stored = await page.evaluate(async () => await window.hermesDesktop.getConnectionConfig())
      assert.equal(stored.mode, 'local', 'The client never dialled an SSH endpoint, so it must not claim one.')
      assert.equal(stored.sshPort, Number(probe.port), 'The saved port must survive a reload.')
      assert.equal(stored.sshKeyPath, probe.key, 'The saved identity file must survive a reload.')
      await page.getByRole('button', { name: 'Connect via SSH', exact: false }).click()
      assert.deepEqual(await readForm(), probe, 'The saved entry must reappear after a reload.')
      return { roundtrip: 'ssh entry survives reload', mode: stored.mode }
    } finally {
      await page.evaluate(
        ([k, value]) => {
          if (value === null) window.localStorage.removeItem(k)
          else window.localStorage.setItem(k, value)
        },
        [key, previous]
      )
    }
  })
  await check('appearance-persistence', async () => {
    await openSettingsSection('Appearance')
    const toggle = page.getByRole('switch', { name: 'Intro Splash', exact: true })
    const original = await toggle.getAttribute('aria-checked')
    const changed = original === 'true' ? 'false' : 'true'
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), changed)
    await page.reload()
    await page.getByRole('switch', { name: 'Intro Splash', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('switch', { name: 'Intro Splash', exact: true }).getAttribute('aria-checked'),
      changed,
      'Preference must survive reload.'
    )
    await page.getByRole('switch', { name: 'Intro Splash', exact: true }).click()
    assert.equal(
      await page.getByRole('switch', { name: 'Intro Splash', exact: true }).getAttribute('aria-checked'),
      original
    )
    return 'Changed preference, reloaded, verified persistence, restored original.'
  })
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await check('url-context', async () => {
    const url = 'https://example.com/web-workflow-probe'
    await page.getByRole('button', { name: 'Add context', exact: true }).click()
    await page.getByRole('menuitem', { name: 'URL…', exact: true }).click()
    await page.getByRole('textbox', { name: 'https://example.com/post', exact: true }).fill(url)
    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    await page.getByRole('button', { name: `Preview ${url}`, exact: true }).waitFor()
    await page.getByRole('button', { name: `Remove ${url}`, exact: true }).click()
    assert.equal(await page.getByRole('button', { name: `Preview ${url}`, exact: true }).count(), 0)
    return 'Added URL context chip and removed it; nothing submitted or fetched.'
  })
  await check('file-picker-upload', async () => {
    // Only the native file dialog is replaced: the renderer, bridge and gateway
    // remain real. A browser handle has bytes and a basename, not a host path.
    const filename = `web-workflow-${Date.now().toString(36)}.txt`
    await page.evaluate(name => {
      window.showOpenFilePicker = async () => [
        { name, getFile: async () => new File(['web attachment probe'], name, { type: 'text/plain' }) }
      ]
      const select = window.hermesDesktop.selectPaths.bind(window.hermesDesktop)
      window.hermesDesktop.selectPaths = async options => {
        const paths = await select(options)
        window.__uploadedWorkflowPaths = paths
        return paths
      }
    }, filename)
    try {
      await page.getByRole('button', { name: 'Add context', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Files…', exact: true }).click()
      await page.getByRole('button', { name: `Preview ${filename}`, exact: true }).waitFor()
      const result = await page.evaluate(async () => {
        const path = window.__uploadedWorkflowPaths?.[0]
        return { path, data: await window.hermesDesktop.readFileDataUrl(path) }
      })
      assert.notEqual(result.path, filename, 'A basename is not a gateway path.')
      assert.equal(typeof result.data, 'string', 'Selected browser file must be uploaded to a gateway-readable path.')
      assert.equal(Buffer.from(result.data.split(',')[1], 'base64').toString(), 'web attachment probe')
      return 'Browser file uploaded, read back from the gateway, byte contents matched.'
    } finally {
      const remove = page.getByRole('button', { name: `Remove ${filename}`, exact: true })
      if (await remove.count()) await remove.click()
      await page.evaluate(async () => {
        delete window.showOpenFilePicker
        for (const path of window.__uploadedWorkflowPaths ?? []) {
          const directory = path.replace(/[/\\\\][^/\\\\]+$/, '')
          await window.hermesDesktop.api({
            path: '/api/files',
            method: 'DELETE',
            body: { path: directory, recursive: true }
          })
        }
      })
    }
  })
  await check('folder-picker-degradation', async () => {
    await page.getByRole('button', { name: 'Add context', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Folder…', exact: true }).click()
    await expandNotifications()
    await page
      .getByText('Browser folders have no gateway path. Choose a folder on the gateway instead.', { exact: false })
      .waitFor()
    return 'Unsupported browser folder is explained visibly, without an unhandled rejection.'
  })
  await check('terminal-ui', async () => {
    // The terminal pane docks into the BOTTOM slot and is deliberately not
    // `collapsible`, so unlike sessions/files/review it never becomes a narrow
    // overlay: at 390x844 it stays in the grid, squeezed to ~53px, and the TUI
    // behind /api/pty gets about six columns. A 23-character probe can never
    // echo back on one line there (measured: the TUI repaints per column, so
    // the string arrives interleaved with cursor moves). Borrow a desktop-width
    // pane for this scenario — the flow below already resizes mid-check anyway
    // — and restore the run's viewport when it finishes.
    if (NARROW_NAV) {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.waitForTimeout(2000)
    }
    const toggle = page.getByRole('button', { name: 'Show right sidebar', exact: true })
    if (await toggle.isVisible()) await toggle.click()
    await page.keyboard.press('Control+Shift+Backquote')
    await page.locator('.xterm').waitFor({ timeout: 30_000 })
    const input = page.locator('.xterm-helper-textarea').first()
    await page.waitForFunction(() => window.__ptyProbe.receivedBytes > 0, undefined, { timeout: 30_000 })
    await input.pressSequentially('workflow-terminal-probe')
    await page.waitForFunction(() => window.__ptyProbe.sent.join('').includes('workflow-terminal-probe'), undefined, {
      timeout: 5000
    })
    await page.waitForFunction(() => window.__ptyProbe.output.includes('workflow-terminal-probe'), undefined, {
      timeout: 30_000
    })
    const beforeResize = await page.evaluate(() => ({
      bytes: window.__ptyProbe.deliveredBytes,
      frames: window.__ptyProbe.sent.filter(frame => frame.startsWith('\u001b[RESIZE:')).length
    }))
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.waitForFunction(
      before =>
        window.__ptyProbe.deliveredBytes > before.bytes &&
        window.__ptyProbe.sent.filter(frame => frame.startsWith('\u001b[RESIZE:')).length > before.frames,
      beforeResize,
      { timeout: 10_000 }
    )
    const probe = await page.evaluate(() => window.__ptyProbe)
    assert.doesNotMatch(
      probe.output,
      /failed|refus|requires a POSIX|not found/i,
      'PTY output must be a live terminal, not a refusal message.'
    )
    assert.ok(probe.output.includes('workflow-terminal-probe'), 'Typed input must be echoed by the real child.')
    await page.keyboard.press('Control+Shift+w')
    await page.waitForFunction(() => window.__ptyProbe.closed > 0, undefined, { timeout: 5000 })
    await page.setViewportSize(viewport)
    return {
      receivedBytes: probe.receivedBytes,
      deliveredBytes: probe.deliveredBytes,
      resizeFrames: probe.sent.filter(frame => frame.startsWith('\u001b[RESIZE:')).length,
      closed: true
    }
  })
  await check('clipboard-copy', async () => {
    // Copy from the CLIENT side is a bridge round trip the public token will
    // hit constantly (session ids, code blocks, terminal selections). Real
    // flow: RIGHT-CLICK a session row in the sidebar → the session context
    // menu (SessionContextMenu wraps every row) → "Copy ID", which routes
    // through writeClipboardText → the bridge's writeClipboard
    // (navigator.clipboard.writeText). The chat-view header trigger exists in
    // the DOM but is hidden on the web surface (w0 h0), so the context menu is
    // THE affordance here. The CLIPBOARD CONTENT is asserted after a reload:
    // the reload proves the copy went to the OS clipboard, not an in-page
    // capture, and doubles as a settle barrier (menu torn down, tab refocused
    // — in-page fits poison readText with NotAllowedError).
    const composer = page.locator('[data-slot="composer-rich-input"], [aria-label="Message"]').first()
    await ensureChatOpen()
    await setNarrowSidebar(true)
    const seedRow = page
      .locator('button.block.w-full.text-left')
      .filter({ hasText: /clipboard[- ]seed/i })
      .first()

    // No seeded row yet (fresh gateway): seed a real session with a cheap turn.
    if ((await seedRow.count()) === 0) {
      await setNarrowSidebar(false)
      await composer.fill('Reply with exactly: ok-clipboard-seed')
      await composer.press('Enter')
      const stop = page.getByRole('button', { name: 'Stop', exact: true })
      const deadline = Date.now() + 150_000
      let sawStop = false
      let settled = false
      while (Date.now() < deadline) {
        if ((await stop.count()) > 0) sawStop = true
        else if (sawStop) {
          settled = true
          break
        }
        await page.waitForTimeout(1000)
      }
      assert.ok(settled, 'the clipboard seed turn must settle (Stop appears, then clears).')
      await page.waitForTimeout(3000)
      await setNarrowSidebar(true)
    }
    await seedRow.waitFor({ timeout: 60_000 })

    const clipBefore = await page.evaluate(() =>
      navigator.clipboard.readText().catch(e => `READ_ERROR: ${e.message.slice(0, 60)}`)
    )
    await seedRow.click({ button: 'right', timeout: 30_000 })
    await page.locator('[role="menuitem"]:has-text("Copy")').last().click({ timeout: 15_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[aria-label="Message"]').first().waitFor({ timeout: 45_000 })
    await ensureChatOpen()
    const clipAfter = await page.evaluate(() =>
      navigator.clipboard.readText().catch(e => `READ_ERROR: ${e.message.slice(0, 60)}`)
    )
    assert.match(
      clipAfter,
      /^[\w-]{16,}$/,
      `the clipboard must hold the copied session id, got: ${clipAfter.slice(0, 80)}`
    )
    assert.notEqual(clipAfter, clipBefore, 'the id must be freshly copied, not pre-existing clipboard content.')
    if (!clipBefore.startsWith('READ_ERROR') && clipBefore !== clipAfter) {
      await page.evaluate(text => navigator.clipboard.writeText(text).catch(() => undefined), clipBefore)
    }
    return { copied: clipAfter.slice(0, 20), survivedReload: true }
  })
  await check('image-large-paste', async () => {
    // A first user pastes a giant log/wall of code. Past the inline limit the
    // composer must convert it to a staged .txt chip (savePastedText) instead
    // of leaving 30k characters in the editor. Asserts the chip, the trimmed
    // editor, the real upload-stream, and the submit wire: the @file: ref must
    // name the staged paste with the canonical pasted_content naming shape.
    // The turn settles so no pending chip bleeds into the next scenario.
    const composer = page.locator('[data-slot="composer-rich-input"], [aria-label="Message"]').first()
    await composer.click()
    await composer.fill('')
    const uploadsBefore = requests.filter(r => r.path === '/api/files/upload-stream').length
    await page.evaluate(() => {
      const clip = new DataTransfer()
      clip.setData('text/plain', 'begin wall of text ' + 'K'.repeat(30_000) + ' end wall of text')
      const el = document.querySelector('[data-slot="composer-rich-input"], [aria-label="Message"]')
      el.focus()
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clip }))
    })
    await page.waitForFunction(() => document.body && /Pasted content/i.test(document.body.innerText), undefined, {
      timeout: 20_000
    })
    const editorLength = await page.evaluate(
      () =>
        (document.querySelector('[data-slot="composer-rich-input"], [aria-label="Message"]')?.innerText ?? '').length
    )
    assert.ok(editorLength < 1_000, `the pasted wall must leave the editor, editorLength=${editorLength}`)
    // The staging upload is ASYNC: the chip mounts before the upload-stream
    // response lands, so a slow gateway shows delta=0 here. Poll briefly.
    const uploadDeadline = Date.now() + 15_000
    let uploadsAfter = 0
    while (Date.now() < uploadDeadline) {
      uploadsAfter = requests.filter(r => r.path === '/api/files/upload-stream').length
      if (uploadsAfter > uploadsBefore) break
      await page.waitForTimeout(250)
    }
    assert.ok(
      uploadsAfter > uploadsBefore,
      `the pasted text must stage via upload-stream (delta=${uploadsAfter - uploadsBefore})`
    )

    const submitsBefore = await page.evaluate(() => window.__submits.length)
    await composer.fill('Acknowledge the pasted text briefly with ok.')
    await composer.press('Enter')
    await page.waitForFunction(n => (window.__submits || []).length > n, submitsBefore, { timeout: 20_000 })
    const frame = (await page.evaluate(() => window.__submits)).map(String)[submitsBefore] ?? ''
    assert.ok(frame.includes('@file:'), `submit must carry the staged file ref, got: ${frame.slice(0, 200)}`)
    assert.match(frame, /pasted_content_[\w-]+\.txt/, 'the staged paste must keep the canonical pasted_content naming.')
    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    const settleDeadline = Date.now() + 180_000
    let sawStop = false
    let settled = false
    while (Date.now() < settleDeadline) {
      if ((await stop.count()) > 0) sawStop = true
      else if (sawStop) {
        settled = true
        break
      }
      await page.waitForTimeout(1000)
    }
    assert.ok(settled, 'the pasted-text turn must settle (Stop appears, then clears).')
    return { editorLength, submittedRef: frame.match(/pasted_content_[\w-]+\.txt/)?.[0] ?? null, settled }
  })
  await check('image-paste-attach', async () => {
    // Paste a PNG into the focused composer: the chip is instant feedback, but
    // the CONTRACT lives on the wire — the next submit must carry image.attach
    // into the managed staging dir, and the gateway must answer attached:true.
    // Then settle the turn so the suite leaves NO queued image behind and
    // attachment-turn starts on a clean session.
    const composer = page.locator('[data-slot="composer-rich-input"], [aria-label="Message"]').first()
    await composer.click()
    await composer.fill('')
    await page.evaluate(bytes => {
      const file = new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' })
      const clip = new DataTransfer()
      clip.items.add(file)
      const el = document.querySelector('[data-slot="composer-rich-input"], [aria-label="Message"]')
      el.focus()
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clip }))
    }, PNG_BYTES)
    await page.getByRole('img', { name: 'pasted.png' }).waitFor({ timeout: 20_000 })
    const submitsBefore = await page.evaluate(() => window.__submits.length)
    await startStopProbe()
    await composer.fill('Describe the attached image in one sentence.')
    await composer.press('Enter')
    // The RPC REPLY comes inbound and doesn't echo the method name — capture
    // it from __gwrecv and correlate by the request's JSON-RPC id.
    await page
      .waitForFunction(() => (window.__gwrecv || []).some(f => String(f).includes('"attached"')), undefined, {
        timeout: 45_000
      })
      .catch(() => undefined)
    const frames = (await page.evaluate(() => window.__submits)).map(String)
    const recv = (await page.evaluate(() => window.__gwrecv)).map(String)
    const attachRequest = frames.find(f => f.includes('image.attach'))
    assert.ok(
      attachRequest && attachRequest.includes('.hermes-web-attachments') && attachRequest.includes('pasted.png'),
      `the attach request must stage the pasted PNG in the managed dir, got: ${attachRequest?.slice(0, 200)}`
    )
    // The channel prefixes ids as STRINGS ("w-48") — parse the request id out
    // generically, without assuming an integer.
    const ridMatch = String(attachRequest ?? '').match(/"id":\s*"?([A-Za-z0-9-]+)"?/)
    const rid = ridMatch ? ridMatch[1] : null
    // Replies may quote the id and/or pad it with spaces ("id": 48) —
    // compare via regex, not literal includes.
    const ridHit = f => rid && new RegExp(`"id":\\s*"?${rid}"?[,:}]`).test(f)
    const attachReply = recv.find(f => ridHit(f) && /"attached"\s*:\s*true/.test(f.replace(/\s+/g, '')))
    // Whatever came back for THIS rid (result or error) goes into the failure
    // message verbatim — "no attached:true" alone can't separate a lost frame
    // from a 4001 session rejection or a malformed result.
    const ridReply =
      recv
        .filter(ridHit)
        .map(f => f.slice(0, 220))
        .join(' ┃ ') || 'NONE'
    // Diagnóstico durante a caça: queue de frames recebidos ao redor do attach.
    console.log(
      'ATTACH WINDOW:',
      JSON.stringify({
        rid,
        submitsAfter: frames.length,
        recvHead: recv.slice(0, 6).map(f => f.slice(0, 80)),
        recvTail: recv.slice(-8).map(f => f.slice(0, 160))
      })
    )
    assert.ok(
      attachReply,
      `the gateway must answer attached:true for image.attach (id ${rid}; reply: ${ridReply}; session in request: ${attachRequest?.match(/"session_id":"([^"]+)"/)?.[1] ?? 'none'})`
    )
    const settleProbe = await assertTurnSettled('the image turn')
    await page.evaluate(() => clearInterval(window.__stopTimer))
    return {
      attachedOnWire: true,
      stagedPath: attachRequest.includes('.hermes-web-attachments'),
      settled: !settleProbe.present
    }
  })
  await check('clipboard-image-real-paste', async () => {
    // saveClipboardImage e2e with a REAL image on the REAL clipboard. The
    // probe found two headless facts this scenario is built on: CDP has no
    // Input.dispatchPasteEvent in this Chromium (130), and clipboard.write
    // DECODES the image on write — so the clipboard only accepts a real,
    // decodable PNG, and re-encodes it (byte count shifts). The real user
    // gesture that drives the member is composer "+" → "Paste image": the
    // bridge reads navigator.clipboard.read(), stages the bytes in the
    // managed dir, and the composer mounts the chip from the staged path.
    try {
      const pngB64 = Buffer.from(PNG_BYTES).toString('base64')
      const clip = await page.evaluate(async b64 => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
        const items = await navigator.clipboard.read()
        const types = items.flatMap(i => i.types)
        let bytesOnClipboard = null
        if (types.includes('image/png')) {
          bytesOnClipboard = [...new Uint8Array(await (await items[0].getType('image/png')).arrayBuffer())]
        }
        return { types, bytesOnClipboard }
      }, pngB64)
      assert.ok(
        clip.types.includes('image/png') && clip.bytesOnClipboard,
        `the real clipboard must hold image/png after write, got ${JSON.stringify(clip.types)}`
      )

      // Observe the member without changing its behavior.
      await page.evaluate(() => {
        const bridge = window.hermesDesktop
        const original = bridge.saveClipboardImage.bind(bridge)
        window.__saveClipboardCalls = []
        bridge.saveClipboardImage = async () => {
          const result = await original()
          window.__saveClipboardCalls.push({ result })
          return result
        }
      })

      await page.getByRole('button', { name: 'Add context', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Paste image', exact: true }).click()
      // The chip is AttachmentPill: a BUTTON whose aria-label is
      // `Preview <staged basename>`, before any thumbnail <img> loads. Probe
      // showed no [role=img] element exists, so select on the real shape.
      const chipButton = page.locator('button[aria-label^="Preview clipboard-image-"]')
      await chipButton.waitFor({ timeout: 20_000 })
      const chipName = (await chipButton.getAttribute('aria-label'))?.replace(/^Preview\s+/, '') ?? null

      const calls = await page.evaluate(() => window.__saveClipboardCalls)
      assert.equal(calls.length, 1, `saveClipboardImage must run exactly once, ran ${calls.length}`)
      const stagedPath = calls[0].result
      assert.ok(
        typeof stagedPath === 'string' && stagedPath.includes('.hermes-web-attachments'),
        `saveClipboardImage must stage into the managed dir, got: ${JSON.stringify(stagedPath)}`
      )
      assert.equal(chipName, stagedPath.split(/[\\/]/).pop(), 'the chip must be named after the staged file')

      // Byte fidelity: the staged file IS the clipboard payload the bridge read.
      const stagedB64 = await page.evaluate(async path => {
        const dataUrl = await window.hermesDesktop.readFileDataUrl(path)
        return dataUrl.split(',')[1]
      }, stagedPath)
      assert.deepEqual(
        Buffer.from(stagedB64, 'base64'),
        Buffer.from(clip.bytesOnClipboard),
        'the staged file must be byte-identical to the clipboard image'
      )

      // Pixel fidelity: it decodes back to the source image (4x2 opaque red).
      const decoded = await page.evaluate(async b64 => {
        const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' })
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        return {
          w: bitmap.width,
          h: bitmap.height,
          data: [...ctx.getImageData(0, 0, bitmap.width, bitmap.height).data]
        }
      }, stagedB64)
      assert.equal(decoded.w, 4)
      assert.equal(decoded.h, 2)
      assert.ok(
        decoded.data.length === 32 && decoded.data.every((b, i) => b === [255, 0, 0, 255][i % 4]),
        `the staged image must decode to the source pixels, got ${JSON.stringify(decoded.data.slice(0, 8))}`
      )

      return { chip: chipName, stagedPath, clipboardBytes: clip.bytesOnClipboard.length }
    } finally {
      // Leave NO chip or staged file behind: attachment-turn starts clean.
      const name = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button[aria-label^="Preview clipboard-image-"]')][0]
        return btn ? btn.getAttribute('aria-label').replace(/^Preview\s+/, '') : null
      })
      if (name) {
        await page
          .getByRole('button', { name: `Remove ${name}`, exact: true })
          .click()
          .catch(() => undefined)
      }
      await page.evaluate(async () => {
        const call = (window.__saveClipboardCalls ?? []).at(-1)
        if (call?.result) {
          const directory = call.result.replace(/[/\\][^/\\]+$/, '')
          await window.hermesDesktop.api({
            path: '/api/files',
            method: 'DELETE',
            body: { path: directory, recursive: true }
          })
        }
      })
    }
  })
  await check('drag-drop-image', async () => {
    // Drag-and-drop e2e with a REAL drag. Probed first: Input.dispatchDragEvent
    // (with Input.setInterceptDrags) drives Chromium's OWN DnD pipeline, so the
    // browser reads the PNG off disk and builds the File itself — the drop
    // arrives `isTrusted:true` with a webkitGetAsEntry()-backed item, which is
    // what an Explorer/Finder drop produces. A page-made DataTransfer also
    // reaches the composer (probed), but it never leaves the renderer, so this
    // scenario keeps the OS-real trigger and asserts the drop really WAS one.
    //
    // Both drop targets are covered because the composer has two handlers: the
    // rich input (handleInputDrop — dropping ON the text box) and the composer
    // ROOT (handleDrop — the "drop anywhere on the composer" affordance). Each
    // must stage the bytes via saveImageBuffer → .hermes-web-attachments, and
    // the submitted turn must carry an image.attach the gateway ACKs.
    const stamp = Date.now().toString(36)
    const dropped = {
      input: { local: path.join(tmpdir(), `dnd-input-${stamp}.png`), name: `dnd-input-${stamp}.png` },
      root: { local: path.join(tmpdir(), `dnd-root-${stamp}.png`), name: `dnd-root-${stamp}.png` }
    }
    const sources = Object.values(dropped)
    for (const source of sources) writeFileSync(source.local, Buffer.from(PNG_BYTES))

    const composer = page.locator('[data-slot="composer-rich-input"]').first()
    const root = page.locator('[data-slot="composer-root"]').first()
    const client = await page.context().newCDPSession(page)
    const chipNames = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('button[aria-label^="Preview "]')].map(button =>
          button.getAttribute('aria-label').replace(/^Preview\s+/, '')
        )
      )
    // Observe saveImageBuffer without changing its behavior — the chip alone
    // can't prove WHICH bytes and name reached the gateway.
    await page.evaluate(() => {
      const bridge = window.hermesDesktop
      window.__saveImageOriginal = bridge.saveImageBuffer.bind(bridge)
      window.__saveImageCalls = []
      bridge.saveImageBuffer = async (data, ext, name) => {
        const result = await window.__saveImageOriginal(data, ext, name)
        window.__saveImageCalls.push({ data, ext, name: name ?? null, result })
        return result
      }
      window.__drops = []
      window.__dropListener = event => {
        const transfer = event.dataTransfer
        window.__drops.push({
          trusted: event.isTrusted,
          targetSlot: event.target?.closest?.('[data-slot]')?.getAttribute('data-slot') ?? null,
          types: transfer ? [...transfer.types] : [],
          files: transfer
            ? [...transfer.files].map(file => ({ name: file.name, size: file.size, type: file.type }))
            : []
        })
      }
      document.addEventListener('drop', window.__dropListener, true)
    })
    await client.send('Input.setInterceptDrags', { enabled: true })
    const uploadStreams = () => requests.filter(request => request.path === '/api/files/upload-stream')
    const dragDataFor = filePath => ({ items: [], files: [filePath], dragOperationsMask: 1 })
    const dragEvent = (type, point, data) =>
      client.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, modifiers: 0, data })

    try {
      assert.deepEqual(await chipNames(), [], 'drag-drop-image must start with an empty composer.')

      // ── the affordance hands off between two targets ─────────────────────
      // MEASURED: the chat-wide sheet (`chat-drop-overlay`, painted by the
      // useFileDropZone handlers on `composer-bounds`) owns the visual while
      // the pointer is over the THREAD. The composer is NOT a DOM descendant of
      // that container — ChatBar lives in the FloatingComposerSurface PORTAL —
      // so crossing onto it fires dragleave on the zone (sheet stands down,
      // zone depth resets) and dragenter on the composer, which shows its OWN
      // affordance (data-drag-active + the surface dimming to opacity-60).
      // Both halves are asserted here, plus the re-arm on the way back.
      const inputBox = await composer.boundingBox()
      const inputPoint = {
        x: Math.round(inputBox.x + inputBox.width / 2),
        y: Math.round(inputBox.y + inputBox.height / 2)
      }
      const boundsBox = await page.locator('[data-slot="composer-bounds"]').first().boundingBox()
      const zonePoint = {
        x: Math.round(boundsBox.x + boundsBox.width / 2),
        y: Math.round(boundsBox.y + 120)
      }
      const inputDrag = dragDataFor(dropped.input.local)
      const affordance = () =>
        page.evaluate(() => {
          const overlay = document.querySelector('[data-slot="chat-drop-overlay"]')
          const surface = document.querySelector('[data-slot="composer-surface"]')
          return {
            dropText: overlay ? /Drop files to attach/i.test(overlay.innerText) : false,
            overlayOpacity: overlay ? Number(getComputedStyle(overlay).opacity) : null,
            composerDragActive:
              document.querySelector('[data-slot="composer-root"]')?.hasAttribute('data-drag-active') ?? false,
            composerSurfaceOpacity: surface ? Number(getComputedStyle(surface).opacity) : null
          }
        })
      const hover = async point => {
        await dragEvent('dragEnter', point, inputDrag)
        await dragEvent('dragOver', point, inputDrag)
        // opacity-transition is 150ms; let the state settle before reading it.
        await page.waitForTimeout(400)
        return affordance()
      }

      // 1) over the transcript region: the sheet names the outcome, the composer
      //    stays out of it (a drag over the thread is not the composer's drop).
      const overThread = await hover(zonePoint)
      assert.equal(
        overThread.dropText,
        true,
        `dragging a file over the chat must name the outcome, got ${JSON.stringify(overThread)}`
      )
      assert.ok(
        overThread.overlayOpacity > 0.5,
        `the drop sheet must actually show while the file is over the thread, got ${JSON.stringify(overThread)}`
      )
      assert.equal(
        overThread.composerDragActive,
        false,
        `a drag over the thread must not mark the composer, got ${JSON.stringify(overThread)}`
      )

      // 2) crossing onto the composer hands the visual over to the composer.
      const overComposer = await hover(inputPoint)
      assert.ok(
        overComposer.composerDragActive,
        `the composer must mark itself a drop target, got ${JSON.stringify(overComposer)}`
      )
      assert.ok(
        overComposer.composerSurfaceOpacity < 1,
        `the composer must show its own drop affordance (dimmed surface), got ${JSON.stringify(overComposer)}`
      )
      // Documented hand-off: the sheet stands down over the composer. It is
      // asserted because it is real, visible behavior — if this ever changes,
      // the change must be intentional, not a silent regression.
      assert.ok(
        overComposer.overlayOpacity < 0.5,
        `the chat-wide sheet must stand down once the pointer is over the composer, got ${JSON.stringify(overComposer)}`
      )

      // 3) back over the thread: the zone must re-arm (depth counter reset).
      const rearmed = await hover(zonePoint)
      assert.ok(
        rearmed.overlayOpacity > 0.5 && !rearmed.composerDragActive,
        `crossing back to the thread must re-arm the sheet and clear the composer, got ${JSON.stringify(rearmed)}`
      )

      // ── drop 1: ON the text box ──────────────────────────────────────────
      const uploadsBefore = uploadStreams().length
      await dragEvent('dragEnter', inputPoint, inputDrag)
      await dragEvent('dragOver', inputPoint, inputDrag)
      await dragEvent('drop', inputPoint, inputDrag)
      const inputChip = page.locator(`button[aria-label="Preview ${dropped.input.name}"]`)
      await inputChip.waitFor({ timeout: 20_000 })

      // Both indicators must clear on drop — a stuck overlay is the classic DnD bug.
      const clearedDeadline = Date.now() + 5000
      let cleared = null
      while (Date.now() < clearedDeadline) {
        cleared = await page.evaluate(() => ({
          overlayOpacity: Number(getComputedStyle(document.querySelector('[data-slot="chat-drop-overlay"]')).opacity),
          composerDragActive:
            document.querySelector('[data-slot="composer-root"]')?.hasAttribute('data-drag-active') ?? false
        }))
        if (cleared.overlayOpacity < 0.5 && !cleared.composerDragActive) break
        await page.waitForTimeout(200)
      }
      assert.ok(
        cleared.overlayOpacity < 0.5 && !cleared.composerDragActive,
        `the drop must clear the drag affordance, got ${JSON.stringify(cleared)}`
      )

      const firstDrop = (await page.evaluate(() => window.__drops))[0]
      assert.ok(firstDrop, 'the drop event must reach the page.')
      assert.equal(firstDrop.trusted, true, `the drop must be a real browser drag, got ${JSON.stringify(firstDrop)}`)
      assert.ok(firstDrop.types.includes('Files'), `the drag must carry files, got ${JSON.stringify(firstDrop)}`)
      assert.deepEqual(
        firstDrop.files,
        [{ name: dropped.input.name, size: PNG_BYTES.length, type: 'image/png' }],
        `Chromium must hand the page the real file, got ${JSON.stringify(firstDrop.files)}`
      )

      // Staging is ASYNC: the chip mounts before the upload-stream response
      // lands, so a slow gateway shows delta=0 here. Poll briefly.
      const uploadDeadline = Date.now() + 15_000
      while (Date.now() < uploadDeadline && uploadStreams().length === uploadsBefore) {
        await page.waitForTimeout(250)
      }
      assert.ok(
        uploadStreams().length > uploadsBefore,
        `the dropped image must stage via upload-stream (delta=${uploadStreams().length - uploadsBefore})`
      )

      const staged = await page.evaluate(() =>
        (window.__saveImageCalls ?? []).map(call => ({ name: call.name, ext: call.ext, result: call.result }))
      )
      assert.equal(staged.length, 1, `the drop must stage exactly one file, staged ${staged.length}`)
      assert.equal(staged[0].name, dropped.input.name, 'the staged file must keep the dropped file name.')
      assert.equal(staged[0].ext, '.png', `the staging extension must come from the PNG, got ${staged[0].ext}`)
      assert.ok(
        staged[0].result.includes('.hermes-web-attachments'),
        `the drop must stage into the managed dir, got ${JSON.stringify(staged[0].result)}`
      )

      // Byte fidelity: unlike the clipboard (which re-encodes on write), this
      // path hands the File's bytes straight through — so they must be IDENTICAL.
      const readStaged = async stagedPath =>
        page.evaluate(
          async filePath => (await window.hermesDesktop.readFileDataUrl(filePath)).split(',')[1],
          stagedPath
        )
      assert.deepEqual(
        Buffer.from(await readStaged(staged[0].result), 'base64'),
        Buffer.from(PNG_BYTES),
        'the staged file must be byte-identical to the dropped PNG'
      )

      // ── drop 2: anywhere on the composer ROOT (the drop-anywhere box) ────
      const rootBox = await root.boundingBox()
      const rootPoint = {
        x: Math.round(rootBox.x + rootBox.width - 60),
        y: Math.round(rootBox.y + rootBox.height - 10)
      }
      const rootDrag = dragDataFor(dropped.root.local)
      await dragEvent('dragEnter', rootPoint, rootDrag)
      await dragEvent('dragOver', rootPoint, rootDrag)
      await dragEvent('drop', rootPoint, rootDrag)
      await page.locator(`button[aria-label="Preview ${dropped.root.name}"]`).waitFor({ timeout: 20_000 })

      const bothStaged = await page.evaluate(() =>
        (window.__saveImageCalls ?? []).map(call => ({ name: call.name, result: call.result }))
      )
      assert.equal(bothStaged.length, 2, `dropping on the composer root must stage too, staged ${bothStaged.length}`)
      assert.equal(bothStaged[1].name, dropped.root.name, 'the second drop must stage its OWN file.')
      assert.deepEqual(
        Buffer.from(await readStaged(bothStaged[1].result), 'base64'),
        Buffer.from(PNG_BYTES),
        'the root-dropped file must also be byte-identical on the gateway'
      )
      // Keep only the text-box drop for the turn: one image, one attach frame.
      await page.getByRole('button', { name: `Remove ${dropped.root.name}`, exact: true }).click({ timeout: 10_000 })
      await page
        .locator(`button[aria-label="Preview ${dropped.root.name}"]`)
        .waitFor({ state: 'detached', timeout: 10_000 })

      // ── the dropped image must reach the MODEL ──────────────────────────
      const submitsBefore = await page.evaluate(() => window.__submits.length)
      // The settle observation starts BEFORE the turn: this scenario polls for
      // the attach frame and then for its reply, so a turn that begins and ends
      // inside that window is never seen busy by a later poll (that is exactly
      // how the image scenarios produced false "never settled" failures).
      await startStopProbe()
      await composer.click()
      await composer.fill('Describe the attached image in one sentence.')
      await composer.press('Enter')
      // MEASURED: `image.attach` goes out as its OWN RPC, and it can land AFTER
      // the `prompt.submit` frame. Reading the slice once right after Enter
      // therefore sees zero attach frames. Waiting on a global "some reply says
      // attached" scan is worse — `__gwrecv` keeps 400 frames across the whole
      // run, so an earlier image scenario's reply satisfies it instantly and the
      // slice is read before this turn's attach. Wait for THIS turn's frame.
      const attachDeadline = Date.now() + 45_000
      let frames = []
      let attachRequests = []
      while (Date.now() < attachDeadline) {
        frames = (await page.evaluate(() => window.__submits)).map(String).slice(submitsBefore)
        attachRequests = frames.filter(frame => frame.includes('image.attach'))
        if (attachRequests.length > 0) break
        await page.waitForTimeout(250)
      }
      assert.equal(
        attachRequests.length,
        1,
        `the dropped image must attach exactly once, got ${attachRequests.length}; frames: ${JSON.stringify(
          frames.map(frame => frame.slice(0, 160))
        )}`
      )
      assert.ok(
        attachRequests[0].includes('.hermes-web-attachments') && attachRequests[0].includes(dropped.input.name),
        `the attach request must cite the staged drop, got: ${attachRequests[0].slice(0, 200)}`
      )
      // The reply does not echo the method name — correlate by the request id,
      // tolerating quoted ids and padded whitespace ("id": 48).
      const rid = String(attachRequests[0]).match(/"id":\s*"?([A-Za-z0-9-]+)"?/)?.[1] ?? null
      const ridHit = frame => rid && new RegExp(`"id":\\s*"?${rid}"?[,:}]`).test(frame)
      // Correlated, so an older scenario's reply cannot satisfy it — but it may
      // still be in flight when the attach frame lands, so poll for it.
      const replyDeadline = Date.now() + 45_000
      let recv = []
      let attachReply = null
      while (Date.now() < replyDeadline && !attachReply) {
        recv = (await page.evaluate(() => window.__gwrecv)).map(String)
        attachReply = recv.find(frame => ridHit(frame) && /"attached"\s*:\s*true/.test(frame.replace(/\s+/g, '')))
        if (!attachReply) await page.waitForTimeout(250)
      }
      assert.ok(
        attachReply,
        `the gateway must answer attached:true for the dropped image (id ${rid}; replies: ${
          recv
            .filter(ridHit)
            .map(frame => frame.slice(0, 200))
            .join(' ┃ ') || 'NONE'
        })`
      )

      const settleProbe = await assertTurnSettled('the dropped-image turn')

      return {
        drops: 2,
        stagedNames: bothStaged.map(call => call.name),
        bytesMatch: true,
        attachedOnWire: true,
        uploadStreams: uploadStreams().length - uploadsBefore,
        stopTicks: settleProbe.seen,
        settled: !settleProbe.present
      }
    } finally {
      // Leave NO chip, staged dir, temp source or patched bridge behind.
      for (const source of sources) {
        await page
          .getByRole('button', { name: `Remove ${source.name}`, exact: true })
          .click({ timeout: 3000 })
          .catch(() => undefined)
      }
      await page.evaluate(async () => {
        for (const call of window.__saveImageCalls ?? []) {
          if (!call?.result) continue
          await window.hermesDesktop
            .api({
              path: '/api/files',
              method: 'DELETE',
              body: { path: call.result.replace(/[/\\][^/\\]+$/, ''), recursive: true }
            })
            .catch(() => undefined)
        }
        if (window.__dropListener) document.removeEventListener('drop', window.__dropListener, true)
        clearInterval(window.__stopTimer)
        delete window.__stopTimer
        delete window.__stopProbe
        delete window.__dropListener
        delete window.__drops
        delete window.__saveImageCalls
        if (window.__saveImageOriginal) {
          window.hermesDesktop.saveImageBuffer = window.__saveImageOriginal
          delete window.__saveImageOriginal
        }
      })
      for (const source of sources) rmSync(source.local, { force: true })
      await client.detach().catch(() => undefined)
    }
  })
  await check('attachment-turn', async () => {
    // The FULL flow a first user performs: pick a file, attach it, send the
    // turn, and see the reply. Everything upstream of the submit is covered by
    // file-picker-upload; this asserts the submit itself — the @file: ref in
    // the prompt must be a real gateway path whose bytes ARE the picked file.
    // The gateway also copies attachments into its own attachments/ dir, so the
    // submitted path is the CANONICAL copy, not the staging UUID dir.
    const nonce = `workflow-attach-${Date.now().toString(36)}`
    const filename = `attach-turn-${Date.now().toString(36)}.txt`
    await page.evaluate(
      ([name, content]) => {
        window.showOpenFilePicker = async () => [
          { name, getFile: async () => new File([content], name, { type: 'text/plain' }) }
        ]
      },
      [filename, nonce]
    )
    try {
      await page.getByRole('button', { name: 'Add context', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Files…', exact: true }).click()
      await page.getByRole('button', { name: `Preview ${filename}`, exact: true }).waitFor({ timeout: 10_000 })

      const composer = page.locator('[data-slot="composer-rich-input"], [aria-label="Message"]').first()
      await composer.click()
      await composer.fill('Read the attached file and reply with exactly its contents.')
      // The pill the attach flow mounts is an AttachmentPill, not a composer
      // ref chip, so it carries no data-ref-text — the submit frame is the
      // only on-the-record statement of what was sent.
      const submitsBefore = await page.evaluate(() => window.__submits.length)
      await composer.press('Enter')

      // Turn settle: busy+empty the composer shows "Stop"; when the turn ends
      // it flips back (idle+empty has NO send button by design — the voice
      // button takes the slot). So: Stop appeared, then disappeared.
      const stop = page.getByRole('button', { name: 'Stop', exact: true })
      const settleDeadline = Date.now() + 180_000
      let sawStop = false
      let settled = false
      while (Date.now() < settleDeadline) {
        if ((await stop.count()) > 0) sawStop = true
        else if (sawStop) {
          settled = true
          break
        }
        await page.waitForTimeout(1000)
      }

      const submits = await page.evaluate(() => window.__submits)
      // FIRST prompt.submit at/after our baseline, never the bare baseline index:
      // an image turn's `image.attach` RPC can land after its own scenario has
      // read the ring, shifting every later index by one (seen for real — this
      // scenario then read the PREVIOUS scenario's attach frame).
      const turnFrame = submits.slice(submitsBefore).find(frame => String(frame).includes('prompt.submit')) ?? null
      assert.ok(turnFrame, 'prompt.submit frame must exist for the attachment turn.')
      const refMatch = turnFrame.match(/@file:([^"\\]+(?:\\\\[^"\\]+)*)/)
      const citedPath = refMatch ? refMatch[1].replace(/\\(.)/g, '$1') : null
      assert.ok(citedPath, `submit must cite @file:, got: ${turnFrame.slice(0, 200)}`)
      assert.ok(settled, 'the turn must settle (Stop appears, then clears).')

      const readBack = await page.evaluate(async path => {
        try {
          const data = await window.hermesDesktop.readFileDataUrl(path)
          return typeof data === 'string' && data.startsWith('data:')
            ? atob(data.split(',')[1])
            : `UNREADABLE: ${JSON.stringify(data).slice(0, 120)}`
        } catch (error) {
          return `READ_ERROR: ${error.message}`
        }
      }, citedPath)
      assert.equal(readBack, nonce, 'the cited @file: path must resolve to the attached bytes.')

      const transcript = await page.evaluate(() => document.body.innerText || '')
      assert.ok(transcript.includes(nonce), 'the agent reply must be visible in the transcript with the file contents.')
      return { citedPath, uploaded: citedPath !== null, settled, bytesMatched: true }
    } finally {
      await page.evaluate(name => {
        delete window.showOpenFilePicker
      }, filename)
    }
  })
} catch (error) {
  // Boot/navigation happens outside check(): retain the failure in the artifact
  // as well as returning nonzero, rather than leaving an empty success report.
  results.push({ name: 'harness', status: 'failed', error: error.message })
  console.error(`FAILED harness: ${error.message}`)
} finally {
  try {
    writeFileSync(
      `${artifacts}/results.json`,
      JSON.stringify({ base, measuredAt: new Date().toISOString(), results, faults, requests }, null, 2)
    )
  } finally {
    await browser.close()
  }
}
// Errors can arrive between checks too. No unhandled renderer exception is
// excused just because it landed outside an individual scenario's time window.
process.exitCode = results.some(result => result.status === 'failed') || faults.length > 0 ? 1 : 0
