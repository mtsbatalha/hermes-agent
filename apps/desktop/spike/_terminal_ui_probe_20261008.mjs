// spike: terminal-ui diagnostic probe (throwaway)
// base http://127.0.0.1:5176/spike.html (override via SPIKE_URL)
// Honest minimal probe: never clobbers the real bridge, waits for real boot,
// reads real DOM + spike/WS state, writes JSON via fs (never via download).
// Fails when no xterm is mounted — a probe that always passes is not a gate.

import { chromium } from 'playwright'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const artifacts = process.env.ARTIFACTS || 'artifacts/workflows'
mkdirSync(artifacts, { recursive: true })

function findChromium() {
  const root = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright')
  if (!existsSync(root)) return undefined
  const candidates = []
  for (const dir of readdirSync(root)) {
    candidates.push(path.join(root, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'))
    candidates.push(path.join(root, dir, 'chrome-win', 'chrome.exe'))
  }
  return candidates.find(existsSync)
}

const exe = findChromium()
console.log(`chromium: ${exe ?? '(padrao do playwright)'}`)

const base = process.env.SPIKE_URL || 'http://127.0.0.1:5176/spike.html'

const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const results = []

// Real WS trace installed before any app code runs (same technique as
// probe.mjs): the app logs nothing about its socket, so without this the
// dump cannot say WHY the gateway looks offline.
await page.addInitScript(() => {
  window.__ws = []
  const Native = window.WebSocket
  window.WebSocket = function (...args) {
    const ws = new Native(...args)
    const entry = { url: String(args[0]), events: [], frames: [] }
    window.__ws.push(entry)
    const nativeSend = ws.send.bind(ws)
    ws.send = (data) => {
      if (entry.frames.length < 60) entry.frames.push(`→ ${String(data).slice(0, 400)}`)
      return nativeSend(data)
    }
    ws.addEventListener('message', (ev) => {
      if (entry.frames.length < 60) entry.frames.push(`← ${String(ev.data).slice(0, 400)}`)
    })
    for (const type of ['open', 'close', 'error']) {
      ws.addEventListener(type, (ev) => {
        const detail = type === 'close' ? ` code=${ev.code} clean=${ev.wasClean} reason=${ev.reason}` : ''
        entry.events.push(`${type}${detail}`)
      })
    }
    return ws
  }
  window.WebSocket.prototype = Native.prototype
  Object.assign(window.WebSocket, Native)
})

try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  // Boot gate in two stages. Stage 1: something painted. Stage 2 (the fix
  // for the 2%-modal snapshot): the setup overlay must be GONE — probe.mjs
  // proves the page settles past it given ~30s, while #root has children
  // from the first frame, so children alone cannot gate on boot.
  await page.waitForFunction(
    () => {
      const composer = document.querySelector('[data-placeholder]')
      const root = document.querySelector('#root')
      return Boolean(composer || (root && root.childElementCount > 0))
    },
    undefined,
    { timeout: 90_000 }
  )
  await page.waitForFunction(
    () => !(document.body.innerText || '').includes('Starting Hermes'),
    undefined,
    { timeout: 90_000 }
  )
  results.push({ name: 'boot', status: 'passed' })

  // The xterm only mounts once the terminal pane is revealed (view.showTerminal
  // defaults to ctrl+`) and a terminal exists (view.newTerminal defaults to
  // ctrl+shift+`). Asserting on a fresh boot page without revealing first
  // fails vacuously — that was the previous false-negative, not a product bug.
  await page.keyboard.press('Control+`')
  const revealed = await page.waitForFunction(() => document.querySelectorAll('.xterm').length > 0, undefined, { timeout: 30_000 }).then(() => true).catch(() => false)
  if (!revealed) {
    await page.keyboard.press('Control+Shift+`')
    await page.waitForFunction(() => document.querySelectorAll('.xterm').length > 0, undefined, { timeout: 30_000 })
  }

  const dump = await page.evaluate(() => {
    const xterms = [...document.querySelectorAll('.xterm')]
    return {
      url: location.href,
      title: document.title,
      canvasCount: xterms.length,
      canvasVisible: xterms.some((el) => el.offsetParent !== null),
      bodyTextHead: (document.body.innerText || '').slice(0, 500),
      bridgeMembers: window.hermesWeb ? window.hermesWeb.capabilities().bridge.length : null,
      ptyProbe: window.__ptyProbe ?? null,
      ws: window.__ws ?? null,
    }
  })

  writeFileSync(`${artifacts}/terminal-ui-debug.json`, JSON.stringify(dump, null, 2))
  await page.screenshot({ path: `${artifacts}/terminal-ui.png` })

  if (dump.canvasCount === 0) {
    results.push({
      name: 'terminal-ui',
      status: 'failed',
      error: `no .xterm mounted (body: ${dump.bodyTextHead.slice(0, 200)})`,
    })
  } else {
    results.push({
      name: 'terminal-ui',
      status: 'passed',
      detail: `xterm=${dump.canvasCount} visible=${dump.canvasVisible}`,
    })
  }
} catch (e) {
  results.push({ name: 'harness', status: 'failed', error: String(e).slice(0, 500) })
  try {
    await page.screenshot({ path: `${artifacts}/harness-failure.png` })
  } catch {}
} finally {
  try { await page.close() } catch {}
  try { await browser.close() } catch {}
}

writeFileSync(`${artifacts}/results.json`, JSON.stringify({ base, measuredAt: new Date().toISOString(), results }, null, 2))
console.log(JSON.stringify(results, null, 2))
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0)
