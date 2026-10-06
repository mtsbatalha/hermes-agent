#!/usr/bin/env node
/**
 * audit-contract — the gate that keeps CAPABILITY-MATRIX.md honest.
 *
 * The matrix claims every member of the `hermesDesktop` bridge is classified.
 * That claim is only worth something if something enforces it. This does.
 *
 *   node tools/audit-contract.mjs           # verify, exit 1 on any drift
 *   node tools/audit-contract.mjs --write   # verify, then rewrite the appendix
 *   node tools/audit-contract.mjs --quiet   # only the exit status
 *
 * It fails, loudly, when:
 *   - a member is declared in src/global.d.ts with no column          (added)
 *   - a member is classified twice or lands in two column maps
 *   - a column C member has no family, or a family has no copy to show
 *   - an A/B member has no note saying what replaces it
 *   - the classification names a member the contract no longer declares (stale)
 *   - src/global.d.ts stops being the source of truth it claims to be
 *   - electron/preload.ts stops implementing a member it used to implement
 *
 * The appendix between the GENERATED markers in ../CAPABILITY-MATRIX.md is
 * generated from here. A hand-edited row is drift too, and --write fixes it.
 *
 * Usage measurement (call sites, files) is counted over src/** the same way the
 * matrix states: the renderer aliases the bridge to `desktop`/`bridge`, so a
 * spelled-only pass undercounts members by 24.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { A, B, C, FAMILIES } from './capability-classification.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const MATRIX = path.join(DESKTOP, 'CAPABILITY-MATRIX.md')
const DTS = path.join(DESKTOP, 'src/global.d.ts')
const PRELOAD = path.join(DESKTOP, 'electron/preload.ts')
const SRC = path.join(DESKTOP, 'src')

const args = new Set(process.argv.slice(2))
const write = args.has('--write')
const quiet = args.has('--quiet')
const log = (...a) => {
  if (!quiet) console.log(...a)
}

// ── 1. the contract ────────────────────────────────────────────────────────
const dtsLines = readFileSync(DTS, 'utf8').split('\n')
// `hermesDesktop` sits at 4 spaces inside `declare global { interface Window {`,
// its members at 6 and namespace members at 8. Matching the wrong indent here
// silently scans the whole file head and happens to look like it worked.
const start = dtsLines.findIndex(l => /^ {4}hermesDesktop: \{$/.test(l))
const end = dtsLines.findIndex((l, i) => i > start && /^ {4}\}$/.test(l))
if (start < 0 || end < 0) {
  console.error('FATAL: could not find the hermesDesktop block in src/global.d.ts')
  console.error('       The matrix names that declaration as its source of truth.')
  process.exit(1)
}

const members = []
let current = null
for (const line of dtsLines.slice(start + 1, end)) {
  const top = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*)(\??):/)
  if (top) {
    current = { name: top[1], optional: top[2] === '?' }
    members.push(current)
    continue
  }
  const nested = line.match(/^ {8}([A-Za-z_][A-Za-z0-9_]*)(\??):/)
  if (nested && current) (current.nested = current.nested || []).push(nested[1])
}

// ── 2. usage over src/** (alias-aware, as the matrix states) ───────────────
const uses = new Map()
const files = new Map()
const spelled = new Set()
const ALIAS = '(?:hermesDesktop|desktop|bridge)'
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) {
      walk(p)
      continue
    }
    if (!/\.(ts|tsx)$/.test(e)) continue
    const txt = readFileSync(p, 'utf8')
    for (const m of members) {
      const dotted = (txt.match(new RegExp(`${ALIAS}\\??\\.${m.name}\\b`, 'g')) || []).length
      const destr = (
        txt.match(new RegExp(`(?:desktop|bridge|hermesDesktop)[^\\n]{0,40}\\{[^}\\n]*\\b${m.name}\\b`, 'g')) || []
      ).length
      if ((txt.match(new RegExp(`(?:window\\.)?hermesDesktop\\??\\.${m.name}\\b`, 'g')) || []).length)
        spelled.add(m.name)
      const n = dotted + destr
      if (n > 0) {
        uses.set(m.name, (uses.get(m.name) || 0) + n)
        if (!files.has(m.name)) files.set(m.name, new Set())
        files.get(m.name).add(p)
      }
    }
  }
}
walk(SRC)

// ── 3. what Electron actually implements ───────────────────────────────────
const preload = readFileSync(PRELOAD, 'utf8')
const exposed = preload.includes("exposeInMainWorld('hermesDesktop'")
if (!exposed) {
  console.error("FATAL: electron/preload.ts no longer calls contextBridge.exposeInMainWorld('hermesDesktop' …)")
  process.exit(1)
}
const implemented = new Set()
for (const m of members) {
  const rx = new RegExp(`^\\s{2}(?:get )?${m.name}\\s*[:(]`, 'm')
  if (rx.test(preload)) implemented.add(m.name)
}

// ── 4. classify, and fail on drift ─────────────────────────────────────────
const failures = []
const assigned = new Map()
const declared = new Set(members.map(m => m.name))
const nestedNames = new Set(members.flatMap(m => (m.nested || []).map(n => n)))

for (const m of members) {
  const inA = Object.hasOwn(A, m.name)
  const inB = Object.hasOwn(B, m.name)
  const inC = Object.hasOwn(C, m.name)
  const hits = [inA && 'A', inB && 'B', inC && 'C'].filter(Boolean)
  if (hits.length === 0) {
    failures.push(`ADDED WITHOUT A COLUMN   ${m.name} — classify it in tools/capability-classification.mjs`)
    continue
  }
  if (hits.length > 1) {
    failures.push(`DOUBLE-CLASSIFIED        ${m.name} is in ${hits.join(' and ')}`)
    continue
  }
  const col = hits[0]
  if (col === 'C') {
    const fam = C[m.name]
    if (!FAMILIES[fam]) failures.push(`CUT WITHOUT A FAMILY     ${m.name} → ${fam}`)
    else if (!FAMILIES[fam].copy) failures.push(`FAMILY WITHOUT COPY      ${fam} has no user-facing copy`)
  } else {
    const note = col === 'A' ? A[m.name] : B[m.name]
    if (!note || !note.trim()) failures.push(`NO REPLACEMENT STATED    ${m.name} (column ${col})`)
  }
  assigned.set(m.name, { col, family: C[m.name], note: col === 'A' ? A[m.name] : col === 'B' ? B[m.name] : '' })
}

// leaf overrides must name a real leaf of a real namespace
for (const key of Object.keys(B)) {
  if (!key.includes('.')) continue
  const [ns, leaf] = key.split('.')
  if (!declared.has(ns)) failures.push(`STALE KEY                ${key} — no such namespace`)
  else if (!nestedNames.has(leaf)) failures.push(`STALE LEAF               ${key} — ${ns} has no member ${leaf}`)
}
// stale top-level keys
for (const map of [A, B, C]) {
  for (const key of Object.keys(map)) {
    const top = key.split('.')[0]
    if (!declared.has(top)) failures.push(`STALE KEY                ${top} is classified but no longer declared`)
  }
}
// every family must actually be used
for (const fam of Object.keys(FAMILIES)) {
  if (!Object.values(C).includes(fam)) failures.push(`UNUSED FAMILY            ${fam} — no cut member points at it`)
}
// preload drift: a member that used to be implemented and no longer is
const previouslyImplemented = JSON.parse(process.env.AUDIT_PREV || '[]')
for (const name of previouslyImplemented) {
  if (declared.has(name) && !implemented.has(name)) {
    failures.push(`PRELOAD REGRESSION       ${name} is declared but preload.ts no longer implements it`)
  }
}

const counts = { A: 0, B: 0, C: 0 }
for (const v of assigned.values()) counts[v.col]++

// ── 4b. the web bridge is COMPLETE: implemented or explicitly cut ───────────
//
// The spike's Proxy made every member look present, so "is this supported?"
// had no answer and the renderer picked a routing branch on a capability that
// did not exist. Completeness is an invariant here, not a promise: every
// declared member is a real transport/browser member on the bridge object, or
// it carries a cut record with the copy the UI shows instead.
let bridge = null
try {
  bridge = await import(pathToFileURL(path.join(DESKTOP, 'web/bridge/index.ts')).href)
} catch (error) {
  failures.push(`WEB BRIDGE UNREADABLE      ${error.message}`)
}

// Vite STRIPS types without checking them, so a type error in the bridge is
// invisible to the build and only shows up as a wrong value at runtime — which
// is how a nullable `this.socket` and a `never`-narrowed handle survived long
// enough to be measured here. `web/` is outside the renderer tsconfig, so this
// gate is the only thing that typechecks it.
if (bridge) {
  try {
    const tsc = path.join(DESKTOP, '../../node_modules/typescript/bin/tsc')
    await new Promise((resolve, reject) => {
      const child = spawnSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--ignoreConfig',
          '--skipLibCheck',
          '--target',
          'es2022',
          '--module',
          'esnext',
          '--moduleResolution',
          'bundler',
          '--allowImportingTsExtensions',
          path.join(DESKTOP, 'web/bridge/index.ts')
        ],
        { encoding: 'utf8' }
      )
      if (child.status === 0) resolve()
      else reject(new Error((child.stdout || child.stderr || '').trim().split('\n').slice(0, 6).join('\n    ')))
    })
    log('types:    web/bridge typechecks clean')
  } catch (error) {
    failures.push(`BRIDGE TYPE ERROR         ${error.message}`)
  }
}

let bridgeCounts = null
if (bridge) {
  const status = bridge.BRIDGE_STATUS ?? {}
  const live = new Set(bridge.IMPLEMENTED_MEMBERS ?? [])
  const ledger = bridge.BRIDGE_LEDGER ?? []

  for (const m of members) {
    const record = status[m.name]
    if (!record) {
      failures.push(
        `BRIDGE INCOMPLETE         ${m.name} is declared, has no web-bridge record, and is not marked as a cut`
      )
      continue
    }
    const isLive = live.has(m.name)
    if (record.kind === 'cut') {
      if (isLive) failures.push(`BRIDGE CONTRADICTION     ${m.name} is marked a cut but is also implemented`)
      if (!record.copy || !record.copy.trim())
        failures.push(`CUT WITHOUT COPY          ${m.name} has no user-facing copy`)
    } else if (!isLive) {
      failures.push(
        `BRIDGE INCOMPLETE         ${m.name} claims to be a ${record.kind} but is absent from the bridge object`
      )
    }
    if (record.kind !== 'cut' && !record.endpoint) {
      failures.push(`NO ENDPOINT STATED        ${m.name} is implemented without naming what backs it`)
    }
  }
  for (const name of live) {
    if (!declared.has(name))
      failures.push(`BRIDGE EXTRA             ${name} is implemented but not declared by the contract`)
  }
  for (const name of Object.keys(status)) {
    if (!declared.has(name))
      failures.push(`STALE BRIDGE KEY         ${name} is in BRIDGE_STATUS but no longer declared`)
  }
  // A key that is PRESENT with an `undefined` value is the placeholder shape
  // this whole exercise exists to delete: it answers `in` and `'x' in desktop`
  // while returning nothing, which is how `undefined as never` reached the first
  // bridge. Walk the real object so the check covers nested namespaces too
  // (`settings.pickDefaultProjectDir` slipped through a top-level-only check).
  const placeholders = []
  const findPlaceholders = (value, path, depth) => {
    if (depth > 3 || value === null || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (child === undefined) placeholders.push(path ? `${path}.${key}` : key)
      else if (typeof child === 'object') findPlaceholders(child, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  findPlaceholders(bridge.createWebBridge(), '', 0)
  for (const p of placeholders) {
    failures.push(
      `BRIDGE PLACEHOLDER       ${p} is present on the bridge with an undefined value — delete it or implement it`
    )
  }
  if (ledger.length !== members.length) {
    failures.push(
      `LEDGER LENGTH            BRIDGE_LEDGER has ${ledger.length} entries, the contract declares ${members.length}`
    )
  }
  const kind = { transport: 0, browser: 0, cut: 0 }
  for (const m of members) if (status[m.name]) kind[status[m.name].kind]++
  bridgeCounts = kind
}

log(`contract: ${members.length} members (${members.filter(m => m.optional).length} optional)`)
log(
  `usage:    ${[...uses.keys()].filter(k => uses.get(k) > 0).length} members reached, ${[...uses.values()].reduce((a, b) => a + b, 0)} call sites`
)
log(`columns:  A=${counts.A} B=${counts.B} C=${counts.C}`)
log(`preload:  ${implemented.size} of ${members.length} declared members implemented in Electron`)
if (bridgeCounts) {
  const liveCount = bridgeCounts.transport + bridgeCounts.browser
  log(
    `web:      ${liveCount}/${members.length} live on the bridge (${bridgeCounts.transport} transport, ${bridgeCounts.browser} browser), ${bridgeCounts.cut} cut`
  )
  const debt = members.filter(m => {
    const col = assigned.get(m.name)?.col
    return col !== 'C' && bridge.BRIDGE_STATUS[m.name]?.kind === 'cut'
  }).length
  if (debt)
    log(`          transport debt: ${debt} members the matrix calls web-native that the bridge does not implement yet`)
}
log(`spelled-only distinct members (the undercount): ${spelled.size}`)

// Report, but do NOT exit yet: --write regenerates the appendix and the bridge
// manifest below, and several failures (a member classified as a cut while the
// bridge serves it, a member with no endpoint) are exactly what regenerating
// fixes. Exiting here made --write unable to repair its own failures. The exit
// code is still 1 — the run fails loudly, it just also leaves the files fixed.
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  ${f}`)
} else {
  log('\nOK — every declared member has exactly one column, every cut has a family')
}

// ── 5. regenerate the appendix ─────────────────────────────────────────────
const order = col =>
  [...assigned.entries()].filter(([, v]) => v.col === col).sort((a, b) => (uses.get(b[0]) || 0) - (uses.get(a[0]) || 0))

const out = []
for (const col of ['A', 'B', 'C']) {
  out.push(`\n#### Column ${col}\n`)
  out.push('| Member | Uses | Files | Endpoint / equivalent |')
  out.push('|---|---:|---:|---|')
  for (const [name, v] of order(col)) {
    const m = members.find(x => x.name === name)
    const nested = (m.nested || []).length
    const cell = v.col === 'C' ? `**${v.family}** — ${FAMILIES[v.family]?.title || 'MISSING FAMILY'}` : v.note || '—'
    out.push(
      `| \`${name}${m.optional ? '?' : ''}\`${nested ? ` <br>_(${nested} members)_` : ''} | ${uses.get(name) || 0} | ${(files.get(name) || new Set()).size} | ${cell} |`
    )
  }
}
const table = out.join('\n')

const BEGIN = '<!-- BEGIN GENERATED APPENDIX -->'
const END = '<!-- END GENERATED APPENDIX -->'
const matrix = readFileSync(MATRIX, 'utf8')
if (!matrix.includes(BEGIN) || !matrix.includes(END)) {
  console.error(`\nFATAL: ${path.relative(DESKTOP, MATRIX)} has no ${BEGIN} / ${END} markers.`)
  process.exit(1)
}
const next = matrix.replace(
  new RegExp(`${BEGIN}[\\s\\S]*${END}`),
  `${BEGIN}\n<!-- generated by tools/audit-contract.mjs --write; do not hand-edit -->\n${table}\n${END}`
)
if (next === matrix) {
  log('appendix: up to date')
} else if (write) {
  writeFileSync(MATRIX, next)
  log('appendix: rewritten')
} else {
  console.error('\nFAIL — the appendix in CAPABILITY-MATRIX.md is stale. Run with --write.')
  process.exit(1)
}

// ── 6. web/bridge/manifest.ts is GENERATED from this same classification ────
//
// It used to be produced by a scratch script kept outside the repo, so the
// ledger's `endpoint` copy could drift from the classification that the audit
// enforces — the terminal member kept claiming "GET /api/pty" long after the
// wire protocol was measured. Generating it here makes that impossible: one
// source, one writer, and a stale manifest fails the run like a stale appendix.
//
// Two inputs, deliberately kept apart:
//
//   KIND      comes from the BRIDGE (is the member actually on the object?),
//             not from the column. A/B/C is the plan; `IMPLEMENTED_MEMBERS` is
//             the fact, and conflating them made `getPoolLimits` read as a cut
//             while the bridge was serving it.
//   WORDING   comes from the classification, so the endpoint a member names
//             cannot rot independently of the matrix.
//
// That split also fixes an honesty bug the hand-built manifest had: `git` was
// recorded as a cut with the copy "Not available in the web client" while
// /api/git/* answers 200. A column-A member that the bridge has simply not
// reached yet is not unavailable — it is unwired, and the copy says so and
// names the endpoint that would back it.
const MANIFEST = path.join(DESKTOP, 'web/bridge/manifest.ts')
const liveMembers = new Set(bridge?.IMPLEMENTED_MEMBERS ?? [])
const statusRecord = m => {
  const v = assigned.get(m.name)
  if (!v) return null
  if (liveMembers.has(m.name)) {
    return v.col === 'B' ? { kind: 'browser', endpoint: v.note } : { kind: 'transport', endpoint: v.note }
  }
  if (v.col === 'C') {
    return { kind: 'cut', copy: FAMILIES[v.family]?.copy || v.note || 'Not available in the web client.' }
  }
  return {
    kind: 'cut',
    copy: `Not wired on the web bridge yet — ${v.note} The capability exists; this client does not call it yet.`
  }
}

const manifestSource = [
  '/**',
  ' * The 157-member ledger for the web bridge. GENERATED by',
  ' * tools/audit-contract.mjs --write.',
  ' *',
  ' * Do not hand-edit: run `node tools/audit-contract.mjs --write`.',
  ' *',
  ' * Two inputs, deliberately kept apart:',
  ' *   kind     read off the BRIDGE — a member is `transport`/`browser` only',
  ' *            while it is actually present on the object in index.ts, and',
  ' *            `cut` the moment it is not. This is what stops a column-A',
  ' *            member from being advertised as working before it is wired.',
  ' *   wording  read off tools/capability-classification.mjs, so the endpoint a',
  ' *            member names cannot rot apart from CAPABILITY-MATRIX.md.',
  ' */',
  '',
  "import type { CapabilityRecord } from './unsupported.ts'",
  '',
  'export const BRIDGE_STATUS: Record<string, CapabilityRecord> = {',
  ...members.map(m => `  ${m.name}: ${JSON.stringify(statusRecord(m))},`),
  '}',
  '',
  '/** Every member the contract declares, in declaration order. */',
  'export const BRIDGE_LEDGER: readonly string[] = [',
  ...members.map(m => `  '${m.name}',`),
  ']',
  ''
].join('\n')

// Formatted with the project's own prettier before it is compared, so this
// generator and `prettier --check` cannot disagree. They did exactly that once:
// the audit wrote a file prettier then reformatted, and the audit called its own
// output stale on the next run. A generator that fights the formatter trains
// people to ignore both.
const PRETTIER = path.join(DESKTOP, '../../node_modules/prettier')
let manifestBody = manifestSource
try {
  const prettier = (await import(pathToFileURL(path.join(PRETTIER, 'index.mjs')).href)).default
  manifestBody = await prettier.format(manifestSource, {
    ...JSON.parse(readFileSync(path.join(DESKTOP, '../../.prettierrc'), 'utf8')),
    parser: 'typescript'
  })
} catch (error) {
  // Prettier missing is not a reason to fail the audit; the unformatted text
  // still round-trips, and `--check` will say so on its own.
  log(`manifest: prettier unavailable (${error.message}); writing unformatted`)
}

const currentManifest = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null
if (currentManifest === manifestBody) {
  log('manifest: up to date')
} else if (write) {
  writeFileSync(MANIFEST, manifestBody)
  log('manifest: rewritten')
} else {
  failures.push('BRIDGE MANIFEST STALE   web/bridge/manifest.ts does not match the classification. Run with --write.')
}

// The verdict is settled LAST, after both generated files have been checked, so
// a run either reports every problem or repairs what it can — never repairs
// half and exits before saying so.
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s):`)
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`)
  process.exit(1)
}
log('\nOK — contract, classification, bridge and generated files all agree')
