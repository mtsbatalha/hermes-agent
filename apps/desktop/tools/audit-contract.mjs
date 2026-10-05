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
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
const log = (...a) => { if (!quiet) console.log(...a) }

// ── 1. the contract ────────────────────────────────────────────────────────
const dtsLines = readFileSync(DTS, 'utf8').split('\n')
// `hermesDesktop` sits at 4 spaces inside `declare global { interface Window {`,
// its members at 6 and namespace members at 8. Matching the wrong indent here
// silently scans the whole file head and happens to look like it worked.
const start = dtsLines.findIndex((l) => /^ {4}hermesDesktop: \{$/.test(l))
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
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!/\.(ts|tsx)$/.test(e)) continue
    const txt = readFileSync(p, 'utf8')
    for (const m of members) {
      const dotted = (txt.match(new RegExp(`${ALIAS}\\??\\.${m.name}\\b`, 'g')) || []).length
      const destr = (txt.match(new RegExp(`(?:desktop|bridge|hermesDesktop)[^\\n]{0,40}\\{[^}\\n]*\\b${m.name}\\b`, 'g')) || []).length
      if ((txt.match(new RegExp(`(?:window\\.)?hermesDesktop\\??\\.${m.name}\\b`, 'g')) || []).length) spelled.add(m.name)
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
const declared = new Set(members.map((m) => m.name))
const nestedNames = new Set(members.flatMap((m) => (m.nested || []).map((n) => n)))

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

log(`contract: ${members.length} members (${members.filter((m) => m.optional).length} optional)`)
log(`usage:    ${[...uses.keys()].filter((k) => uses.get(k) > 0).length} members reached, ${[...uses.values()].reduce((a, b) => a + b, 0)} call sites`)
log(`columns:  A=${counts.A} B=${counts.B} C=${counts.C}`)
log(`preload:  ${implemented.size} of ${members.length} declared members implemented in Electron`)
log(`spelled-only distinct members (the undercount): ${spelled.size}`)

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
log('\nOK — every declared member has exactly one column, every cut has a family')

// ── 5. regenerate the appendix ─────────────────────────────────────────────
const order = (col) =>
  [...assigned.entries()]
    .filter(([, v]) => v.col === col)
    .sort((a, b) => (uses.get(b[0]) || 0) - (uses.get(a[0]) || 0))

const out = []
for (const col of ['A', 'B', 'C']) {
  out.push(`\n#### Column ${col}\n`)
  out.push('| Member | Uses | Files | Endpoint / equivalent |')
  out.push('|---|---:|---:|---|')
  for (const [name, v] of order(col)) {
    const m = members.find((x) => x.name === name)
    const nested = (m.nested || []).length
    const cell = v.col === 'C'
      ? `**${v.family}** — ${FAMILIES[v.family]?.title || 'MISSING FAMILY'}`
      : (v.note || '—')
    out.push(`| \`${name}${m.optional ? '?' : ''}\`${nested ? ` <br>_(${nested} members)_` : ''} | ${uses.get(name) || 0} | ${(files.get(name) || new Set()).size} | ${cell} |`)
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