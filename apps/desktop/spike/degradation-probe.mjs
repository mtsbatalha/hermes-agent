/**
 * Runtime screen degradation — which cut members does a screen REALLY touch?
 *
 * The static walk in tools/screen-degradation.mjs answers "which files can this
 * screen import". With `@/…` resolved it found every screen reaches ~832 of the
 * 2722 files under src/: the barrels (`export * from`) and the shared store pull
 * in nearly everything, so per-screen attribution collapses into "all screens
 * reach all cut members". That is true of the IMPORT GRAPH and useless as an
 * answer about the screen.
 *
 * So this measures the thing we actually care about, in a real browser: load each
 * route, record every `hermesDesktop.<member>` the renderer reads while the
 * screen is on, and report the ones the bridge does not define.
 *
 * A measurement-only Proxy is used here and NOWHERE in the shipped bridge. The
 * whole reason the bridge is an object literal instead of a Proxy is that a
 * Proxy with an always-true `has()` made the renderer pick a routing path that
 * did not exist. Wrapping it for measurement is fine; shipping it is not.
 *
 * Reach is NOT the same as breakage: the renderer can read an absent member
 * through `?.` and short-circuit, which is the honest degradation path. So this
 * reports reach per route, and `--fail-on-error` gates on the renderer actually
 * THROWING, which is the part that would be a defect.
 *
 * Usage: node spike/degradation-probe.mjs [--base http://127.0.0.1:5176]
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { C } from '../tools/capability-classification.mjs'

import pw from 'file:///C:/Users/Mateus/Documents/freebuff/hermes-client/hermes-agent/node_modules/playwright/index.js'
const { chromium } = pw

const argBase = process.argv.indexOf('--base')
const BASE = argBase === -1 ? 'http://127.0.0.1:5176' : process.argv[argBase + 1]

/** APP_ROUTES from src/app/routes.ts. */
const ROUTES = [
  ['/', 'Chat (session)'],
  ['/settings', 'Settings'],
  ['/command-center', 'Command Center'],
  ['/capabilities', 'Capabilities'],
  ['/messaging', 'Messaging'],
  ['/webhooks', 'Webhooks'],
  ['/artifacts', 'Artifacts'],
  ['/cron', 'Cron'],
  ['/profiles', 'Profiles'],
  ['/agents', 'Agents'],
  ['/starmap', 'Starmap'],
  ['/session-import', 'Session import']
]

const CUTS = Object.keys(C).sort()

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

mkdirSync('spike/artifacts', { recursive: true })

const exe = findChromium()
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

/**
 * Trap the bridge BEFORE the renderer boots. installWebBridge does
 * `target.hermesDesktop = createWebBridge()`; this wraps whatever it assigns so
 * every member read is recorded, with the file that read it.
 */
await page.addInitScript(cutNames => {
  window.__cut = []
  const seen = new Set()
  let real
  const wrap = value => {
    if (!value || typeof value !== 'object') return value
    return new Proxy(value, {
      get(target, prop, recv) {
        if (typeof prop === 'string' && cutNames.includes(prop)) {
          const hit = `${prop}`
          if (!seen.has(hit)) {
            seen.add(hit)
            const stack = (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ')
            window.__cut.push({ member: prop, present: prop in target, stack: stack.slice(0, 400) })
          }
        }
        return Reflect.get(target, prop, recv)
      }
    })
  }
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    get: () => real,
    set: value => {
      real = wrap(value)
    }
  })
}, CUTS)

const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

const results = []
const base = `${BASE}/spike.html`

for (const [route, label] of ROUTES) {
  pageErrors.length = 0
  await page.goto(`${base}#${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // The app boots on the hash route; wait for a painted root, then let the
  // screen's own effects run before reading the log.
  await page.waitForSelector('#root > *', { timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(3500)
  const cut = await page.evaluate(() => (window.__cut ?? []).map(c => ({ ...c })))
  const present = cut.filter(c => c.present)
  const absent = cut.filter(c => !c.present)
  results.push({ route, label, total: cut.length, absent, present, errors: [...pageErrors] })
  const mark = absent.length === 0 ? '✓' : '·'
  console.log(
    `  ${mark} ${route.padEnd(16)} ${label.padEnd(18)} ${cut.length} member(s) read · ${absent.length} cut & absent`
  )
  for (const a of absent)
    console.log(`       cut+absent ${a.member.padEnd(24)} ${a.stack.split(' | ')[0]?.trim() ?? ''}`)
  for (const e of pageErrors.slice(0, 3)) console.log(`       ERROR     ${e.slice(0, 160)}`)
}

await browser.close()

console.log('')
const withCut = results.filter(r => r.absent.length > 0)
const withErrors = results.filter(r => r.errors.length > 0)
console.log(`  routes measured: ${results.length}`)
console.log(`  routes touching a cut member: ${withCut.length}`)
console.log(`  routes with a page error: ${withErrors.length}`)
const allAbsent = [...new Set(results.flatMap(r => r.absent.map(a => a.member)))].sort()
console.log(
  `  distinct cut members read at runtime: ${allAbsent.length} of ${CUTS.length} — ${allAbsent.join(', ') || '(none)'}`
)
console.log('')

if (process.argv.includes('--fail-on-error') && withErrors.length > 0) process.exit(1)
