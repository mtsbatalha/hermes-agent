/**
 * SPIKE ONLY — Fase 0 acceptance gate.
 *
 * Drives the real Desktop UI in a headless browser against a live
 * `hermes serve` gateway and asserts on the WIRE PROTOCOL, not on rendered
 * text: streaming is `message.start` -> `message.delta` -> `message.complete`.
 * UI text lags and reorders; protocol frames do not.
 *
 * Two flows, both part of the gate:
 *   1. STREAMING — a message goes out and the reply comes back token by token.
 *   2. SESSION SWITCH — two sessions are created through the real UI, one
 *      message sent in each, and the transcripts are checked for leakage in
 *      BOTH directions. A regression here must fail the gate, not pass quietly.
 *
 * Leakage assertion: the sidebar legitimately lists every session, so a marker
 * appearing once means "row only, not in the transcript" and twice means
 * "row AND transcript". That distinguishes contamination from normal presence
 * without hard-coding a transcript container selector.
 *
 * Usage:
 *   node spike/stream.mjs [--width N] [--height N] [--label name] [--url u]
 *                          [--message "..."] [--keep-screenshots]
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const width = Number(argOf('width', 1280))
const height = Number(argOf('height', 900))
const label = argOf('label', `${width}x${height}`)
const url = argOf('url', 'http://127.0.0.1:5176/spike.html')
// Unique per run so a stale transcript from an earlier session can never make a
// leak assertion pass by accident.
const runId = Date.now().toString(36).slice(-5)
const MARK_A = `alpha-${runId}`
const MARK_B = `beta-${runId}`

mkdirSync('spike/artifacts', { recursive: true })

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
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage({ viewport: { width, height } })

// Wire-level trace installed before any app code runs. The UI never reports its
// own socket lifecycle, so this is the only place the protocol is visible.
await page.addInitScript(() => {
  window.__ws = []
  const Native = window.WebSocket
  window.WebSocket = function (...args) {
    const ws = new Native(...args)
    const entry = { url: String(args[0]), events: [], frames: [] }
    window.__ws.push(entry)
    const cap = (dir, data) => {
      if (entry.frames.length < 4000) entry.frames.push(`${dir} ${String(data).slice(0, 600)}`)
    }
    const nativeSend = ws.send.bind(ws)
    ws.send = data => { cap('→', data); return nativeSend(data) }
    ws.addEventListener('message', ev => cap('←', ev.data))
    ws.addEventListener('close', ev => entry.events.push(`close(${ev.code}, clean=${ev.wasClean})`))
    ws.addEventListener('open', () => entry.events.push('open'))
    return ws
  }
  window.WebSocket.prototype = Native.prototype
  Object.assign(window.WebSocket, Native)
})

const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(String(e)))

const failures = []
const fail = msg => { failures.push(msg); console.log(`  ✗ ${msg}`) }
const pass = msg => console.log(`  ✓ ${msg}`)

const shot = n => page.screenshot({ path: `spike/artifacts/stream-${label}-${n}.png` })

console.log(`→ gate @ ${label} (${url})  markers: ${MARK_A} / ${MARK_B}`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

/**
 * Wait for the app to be genuinely ready before sending anything. The
 * composer placeholder is the app's own readiness signal: while the gateway is
 * down it reads "Reconnecting to Hermes…" / "Starting Hermes…" instead of a
 * resting prompt.
 *
 * Sending into that window is what made the FIRST turn of a cold start time out
 * intermittently — the boot burst competes with the turn for the same backend.
 * A fixed sleep hid this by luck rather than by design.
 */
const composerEl = page.locator('[data-slot="composer-rich-input"], [aria-label="Message"]').first()
async function waitUntilReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ph = await composerEl.getAttribute('data-placeholder').catch(() => null)
    if (ph && !/Reconnecting|Starting Hermes/i.test(ph)) return ph
    await page.waitForTimeout(1000)
  }
  return null
}
const readyPh = await waitUntilReady()
readyPh
  ? pass(`app pronto (placeholder: "${readyPh.slice(0, 48)}")`)
  : fail('app não ficou pronto — placeholder ainda em estado de boot')

const gwFrames = () =>
  page.evaluate(() => (window.__ws ?? []).filter(s => s.url.includes('/api/ws')).flatMap(s => s.frames ?? []))

const countEvents = (frames, name) => frames.filter(f => f.includes(`"${name}"`)).length

/** Send a message through the real composer and wait for the turn to finish. */
async function sendTurn(text, labelShot) {
  const before = countEvents(await gwFrames(), 'message.complete')
  await composerEl.click()
  await composerEl.fill(text)
  await page.waitForTimeout(250)
  await shot(labelShot)
  await composerEl.press('Enter')

  // Condition-based wait: the turn ends when a new message.complete lands.
  //
  // The deadline has to cover the BACKEND's retry semantics, not the client's
  // patience. A rate-limited provider makes the gateway hold the turn and retry
  // on a ~60s cycle up to 3 attempts, so a 120s budget expired mid-retry and
  // reported a stall that was never a client defect. 300s covers the full cycle
  // plus margin; `rateLimitedBy` below keeps that condition attributable.
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    if (countEvents(await gwFrames(), 'message.complete') > before) return true
  }
  return false
}

/** Did the transcript show a provider rate-limit retry notice? */
const rateLimited = () =>
  page.evaluate(() => /rate limited/i.test(document.body.innerText || ''))

/** How many times a marker is rendered in the document. */
const markerCount = async marker => {
  return page.evaluate(m => {
    const text = document.body.innerText || ''
    let count = 0
    let i = text.indexOf(m)
    while (i !== -1) { count++; i = text.indexOf(m, i + m.length) }
    return count
  }, marker)
}

/** Is a sidebar row for this session currently rendered? */
const rowVisible = async marker =>
  page.locator('[data-slot="row-button"]', { hasText: marker }).first().isVisible().catch(() => false)

/**
 * Expected renderings of an ACTIVE session's marker: twice when its sidebar row
 * is on screen (row + transcript), once when the sidebar is collapsed and only
 * the transcript shows. Hard-coding either number produced a false failure at
 * 390px, so the expectation follows the layout.
 */
const expectActive = async marker => ((await rowVisible(marker)) ? 2 : 1)

/**
 * Reveal the collapsed session sidebar at phone width.
 *
 * The label is DYNAMIC — "Show sidebar" becomes "Show sidebar · 1 unread
 * session" once a session exists — so this matches by prefix. An exact match
 * silently found nothing at 390px after the first turn and looked exactly like
 * the session list being unreachable.
 */
const openSidebar = async () => {
  const toggle = page.locator('[aria-label^="Show sidebar"]').first()
  if (!(await toggle.isVisible().catch(() => false))) return false
  await toggle.click()
  await page.waitForTimeout(1500)
  return true
}

// ── Flow 1: streaming in the first session ──────────────────────────────────
console.log('\n=== FLUXO 1: streaming ===')
const turnA = await sendTurn(`Turn A probe ${MARK_A}. Reply with exactly: okA`, '1-sessionA')
const framesAfterA = await gwFrames()
const deltasA = countEvents(framesAfterA, 'message.delta')

if (turnA) pass('turno A completou (message.complete)')
else fail(`turno A não completou${(await rateLimited()) ? ' — provedor rate limited (upstream, não é falha do cliente)' : ''}`)
deltasA > 0 ? pass(`${deltasA} message.delta recebidos`) : fail('nenhum message.delta no turno A')

// ── Flow 2: session switch, both directions ────────────────────────────────
console.log('\n=== FLUXO 2: troca de sessão ===')

const newSession = page.locator('[data-slot="sidebar-menu-item"]', { hasText: 'New session' }).first()
let createdB = false
if (await newSession.isVisible().catch(() => false)) {
  await newSession.click()
  createdB = true
} else {
  // Narrow layouts collapse the sidebar; Ctrl+N is the documented shortcut.
  await page.keyboard.press('Control+n')
  createdB = true
  console.log('  (sidebar oculta — usando Ctrl+N)')
}
await page.waitForTimeout(2500)
createdB ? pass('nova sessão criada pela UI') : fail('não foi possível criar a sessão B')

const turnB = await sendTurn(`Turn B probe ${MARK_B}. Reply with exactly: okB`, '2-sessionB')
const framesAfterB = await gwFrames()
const deltasB = countEvents(framesAfterB, 'message.delta')

if (turnB) pass('turno B completou (message.complete)')
else fail(`turno B não completou${(await rateLimited()) ? ' — provedor rate limited (upstream, não é falha do cliente)' : ''}`)
deltasB > 0 ? pass(`${deltasB - deltasA} message.delta novos no turno B`) : fail('nenhum message.delta no turno B')

const aInB = await markerCount(MARK_A)
const bInB = await markerCount(MARK_B)
const expB = await expectActive(MARK_B)
// A's own transcript must contribute exactly one rendering beyond its sidebar
// row — i.e. A must not be in B's transcript.
const aExpected = (await rowVisible(MARK_A)) ? 1 : 0
console.log(`  B ativa -> A ${aInB}x (esperado ${aExpected}), B ${bInB}x (esperado ${expB})`)
aInB === aExpected
  ? pass('transcript de B NÃO contém o texto da sessão A')
  : fail(`VAZAMENTO: texto da sessão A aparece ${aInB}x com B ativa (esperado ${aExpected})`)
bInB === expB
  ? pass('transcript de B contém o texto da sessão B')
  : fail(`texto da sessão B ausente do próprio transcript (${bInB}x, esperado ${expB})`)
await shot('3-sessionB-active')

// Switch back to A through the sidebar, and VERIFY the switch rather than
// assuming it: the earlier version clicked whatever control it could find and
// reported success regardless.
if (!(await rowVisible(MARK_A))) await openSidebar()
const rowA = page.locator('[data-slot="row-button"]', { hasText: MARK_A }).first()
const rowReachable = await rowA.isVisible().catch(() => false)
rowReachable ? await rowA.click() : fail('linha da sessão A não alcançável na sidebar')
await page.waitForTimeout(5000)
await shot('4-sessionA-restored')

const aInA = await markerCount(MARK_A)
const bInA = await markerCount(MARK_B)
const expA = await expectActive(MARK_A)
const bExpected = (await rowVisible(MARK_B)) ? 1 : 0
console.log(`  A ativa -> A ${aInA}x (esperado ${expA}), B ${bInA}x (esperado ${bExpected})`)

aInA === expA
  ? pass('transcript de A contém o texto da sessão A (troca realmente ocorreu)')
  : fail(`a troca para A nao ocorreu: A aparece ${aInA}x, esperado ${expA}`)
bInA === bExpected
  ? pass('transcript de A NÃO contém o texto da sessão B')
  : fail(`VAZAMENTO: texto da sessão B aparece ${bInA}x com A ativa (esperado ${bExpected})`)

// ── Report ─────────────────────────────────────────────────────────────────
const all = await gwFrames()
const sockets = (await page.evaluate(() => window.__ws ?? [])).filter(s => s.url.includes('/api/ws'))
const closed = sockets.filter(s => s.events.some(e => e.startsWith('close'))).length

console.log('\n=== RESUMO DO GATE ===')
console.log(`sockets /api/ws      : ${sockets.length} (fechados: ${closed})`)
console.log(`frames enviados      : ${all.filter(f => f.startsWith('→')).length}`)
console.log(`frames recebidos     : ${all.filter(f => f.startsWith('←')).length}`)
console.log(`message.start        : ${countEvents(all, 'message.start')}`)
console.log(`message.delta        : ${countEvents(all, 'message.delta')}`)
console.log(`message.complete     : ${countEvents(all, 'message.complete')}`)
console.log(`frames de tool       : ${all.filter(f => /"type"\s*:\s*"tool/.test(f)).length}`)
console.log(`erros de console     : ${consoleErrors.length}`)

console.log('\n=== ERROS DE CONSOLE ===')
console.log(consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 6).join('\n') : '(nenhum)')

const streamingOk = countEvents(all, 'message.start') > 0 && countEvents(all, 'message.delta') > 0 && countEvents(all, 'message.complete') > 0
const switchOk = failures.length === 0

console.log(`\nRESULT: ${streamingOk && switchOk ? 'PASS' : 'FAIL'}`)
if (!streamingOk) console.log('  - streaming incompleto no protocolo')
for (const f of failures) console.log(`  - ${f}`)

await browser.close()
process.exit(streamingOk && switchOk ? 0 : 1)