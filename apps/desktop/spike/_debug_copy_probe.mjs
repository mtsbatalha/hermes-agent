// THROWAWAY diagnostic probe (not a gate): why do connection-apply and
// folder-picker-degradation not see their refusal copy? Splits "bridge
// rejects" from "renderer renders" with direct bridge calls + DOM dumps.
// Writes spike/artifacts/workflows/debug-copy-probe.json + 2 PNGs (new names).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.WEB_SPIKE_URL ?? 'http://127.0.0.1:5176/spike.html'
const artifacts = 'spike/artifacts/workflows'
mkdirSync(artifacts, { recursive: true })
const browsers = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright')
const executablePath = existsSync(browsers)
  ? readdirSync(browsers).flatMap(d => [path.join(browsers, d, 'chrome-win', 'chrome.exe'), path.join(browsers, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')]).find(existsSync)
  : undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const out = {}
await page.goto(base)
await page.locator('[aria-label="Message"]').waitFor({ timeout: 45_000 })
await page.waitForFunction(() => {
  const input = document.querySelector('[aria-label="Message"]')
  return input?.getAttribute('data-placeholder') && !/Reconnecting|Starting Hermes/i.test(input.getAttribute('data-placeholder'))
}, undefined, { timeout: 90_000 })

// 1. Bridge-level truth: does applyConnectionConfig reject with the copy?
out.bridgeApply = await page.evaluate(async () => {
  try { await window.hermesDesktop.applyConnectionConfig(); return { rejected: false } }
  catch (e) { return { rejected: true, message: String(e?.message ?? e).slice(0, 300), detail: String(e?.detail ?? '').slice(0, 300) } }
})
// 2. UI walk: settings -> Gateways -> Save and reconnect -> scan for copy.
await page.getByRole('button', { name: 'Open settings', exact: true }).click()
await page.getByRole('button', { name: 'Gateways', exact: true }).click()
await page.getByRole('button', { name: 'Save and reconnect', exact: true }).click()
await page.waitForTimeout(6000)
out.uiApply = await page.evaluate(() => {
  const body = document.body.innerText || ''
  const hasFull = body.includes('Switching gateways is not supported in this web client yet')
  const hasPartial = /switching gateways/i.test(body)
  const toastish = [...document.querySelectorAll('[data-sonner-toast],[role="status"],[role="alert"],[data-slot*="toast"],[data-slot*="notification"]')]
    .map(el => (el.innerText || '').slice(0, 300)).filter(Boolean)
  return { hasFull, hasPartial, toastCount: toastish.length, toasts: toastish.slice(0, 4), bodyTail: body.slice(-800) }
})
await page.screenshot({ path: `${artifacts}/debug-copy-apply.png` })

// 3. Folder walk: back to chat, Add context -> Folder… -> scan.
await page.keyboard.press('Escape')
await page.locator('[aria-label="Message"]').first().waitFor({ timeout: 30_000 }).catch(() => {})
await page.getByRole('button', { name: 'Add context', exact: true }).click()
await page.getByRole('menuitem', { name: 'Folder…', exact: true }).click()
await page.waitForTimeout(6000)
out.uiFolder = await page.evaluate(() => {
  const body = document.body.innerText || ''
  return {
    hasFull: body.includes('Browser folders have no gateway path'),
    hasPartial: /no gateway path/i.test(body),
    bodyTail: body.slice(-800)
  }
})
await page.screenshot({ path: `${artifacts}/debug-copy-folder.png` })
await browser.close()
writeFileSync(`${artifacts}/debug-copy-probe.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
