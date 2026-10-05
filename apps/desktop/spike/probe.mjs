/**
 * SPIKE ONLY — Fase 0 harness.
 *
 * Loads the spike page in Chromium and reports what the renderer actually did:
 * whether it painted, what it asked the bridge for, and what the bridge could
 * not answer. Console output and page errors are captured because a renderer
 * that fails to boot usually says why only there.
 *
 * Usage: node spike/probe.mjs [--url <url>] [--width <n>] [--height <n>]
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

const url = argOf('url', 'http://127.0.0.1:5175/spike.html')
const width = Number(argOf('width', 1280))
const height = Number(argOf('height', 900))
const label = argOf('label', `${width}x${height}`)

mkdirSync('spike/artifacts', { recursive: true })

/**
 * This machine's Playwright (1.62.1) expects a browser revision it does not
 * have, so resolve whatever Chromium is actually installed rather than failing
 * on a revision mismatch.
 */
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

const executablePath = findChromium()
console.log(`chromium: ${executablePath ?? '(padrao do playwright)'}`)

const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width, height } })

const consoleLines = []
const pageErrors = []
const failedRequests = []
const badResponses = []

page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => pageErrors.push(String(e)))
page.on('requestfailed', r => failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
page.on('response', r => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
})

console.log(`→ ${url} @ ${label}`)

// Trace the gateway socket before any app code runs: a WS that opens and is then
// dropped is invisible in the app's own UI, which just reports "offline".
await page.addInitScript(() => {
  window.__ws = []
  const Native = window.WebSocket
  window.WebSocket = function (...args) {
    const ws = new Native(...args)
    const entry = { url: String(args[0]), events: [], frames: [] }
    window.__ws.push(entry)

    // Frame-level trace. The app logs nothing about its socket, so the only way
    // to see WHY it closes is to record what went over the wire first.
    const cap = (dir, data) => {
      if (entry.frames.length < 60) {
        entry.frames.push(`${dir} ${String(data).slice(0, 400)}`)
      }
    }
    const nativeSend = ws.send.bind(ws)
    ws.send = data => { cap('→', data); return nativeSend(data) }
    ws.addEventListener('message', ev => cap('←', ev.data))

    for (const type of ['open', 'close', 'error']) {
      ws.addEventListener(type, ev => {
        const detail =
          type === 'close' ? ` code=${ev.code} clean=${ev.wasClean} reason=${ev.reason}` : ''
        entry.events.push(`${type}${detail}`)
      })
    }
    return ws
  }
  window.WebSocket.prototype = Native.prototype
  Object.assign(window.WebSocket, Native)
})

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

// The boot burst is deliberately generous upstream (STARTUP_REQUEST_TIMEOUT_MS
// is 60s), so give the app room before judging it.
await page.waitForTimeout(30_000)

const state = await page.evaluate(() => {
  const root = document.querySelector('#root')
  const spike = window.__spike
  return {
    hasRoot: Boolean(root),
    rootChildCount: root?.childElementCount ?? 0,
    rootHtmlLength: root?.innerHTML.length ?? 0,
    bodyText: (document.body.innerText || '').slice(0, 1200),
    title: document.title,
    missing: spike?.missing ?? null,
    accessed: spike?.accessed ? spike.accessed() : null,
    sockets: window.__ws ?? null
  }
})

await page.screenshot({ path: `spike/artifacts/spike-${label}.png`, fullPage: false })

console.log('\n=== ESTADO DA PAGINA ===')
console.log(JSON.stringify({ ...state, accessed: state.accessed ? `${state.accessed.length} membros` : null }, null, 2))

console.log('\n=== WEBSOCKETS ===')
console.log(state.sockets?.length ? JSON.stringify(state.sockets, null, 2) : '(nenhum)')

console.log('\n=== FRAMES DO SOCKET DO GATEWAY ===')
for (const s of (state.sockets ?? []).filter(s => s.url.includes('/api/ws'))) {
  console.log(`--- ${s.url}`)
  console.log(`    eventos: ${s.events.join(' | ')}`)
  for (const f of s.frames ?? []) console.log(`    ${f}`)
}

console.log('\n=== CAPACIDADES AUSENTES (o achado central) ===')
console.log(state.missing?.length ? state.missing.join('\n') : '(nenhuma — boot completo sem stub)')

console.log('\n=== MEMBROS TOCADOS ===')
console.log(state.accessed?.join(', ') ?? '(n/d)')

console.log('\n=== PAGE ERRORS ===')
console.log(pageErrors.length ? pageErrors.slice(0, 15).join('\n---\n') : '(nenhum)')

console.log('\n=== REQUESTS FALHADOS ===')
console.log(failedRequests.length ? failedRequests.slice(0, 15).join('\n') : '(nenhum)')

console.log('\n=== RESPOSTAS >= 400 ===')
console.log(badResponses.length ? [...new Set(badResponses)].slice(0, 15).join('\n') : '(nenhuma)')

console.log('\n=== CONSOLE (ultimas 40) ===')
console.log(consoleLines.slice(-40).join('\n') || '(vazio)')

await browser.close()