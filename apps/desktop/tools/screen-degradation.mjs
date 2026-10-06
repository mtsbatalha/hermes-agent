/**
 * Screen degradation — what does the renderer still EXPECT after the cuts?
 *
 * The capability matrix says 58 of 157 members are column C: no browser
 * equivalent, cut in v1. That is a statement about CAPABILITIES. It says nothing
 * about whether the renderer copes. This tool answers the question the matrix
 * could not:
 *
 *   For each screen the user can navigate to, which cut members does its module
 *   graph still reach, and what happens when it does?
 *
 * WHY THE OUTCOME IS NOT "present or absent"
 * -----------------------------------------
 * The bridge OMITS cut members rather than defining them as `undefined` (a test
 * asserts no key holds undefined). So `window.hermesDesktop?.revealLogs?.()`
 * short-circuits and the renderer draws its fallback — fine. The SAME line
 * without the inner `?.` evaluates `undefined(...)` and throws TypeError.
 * Optional chaining on the RECEIVER hides the missing receiver; it does not
 * defend against a missing member.
 *
 * That makes three outcomes, not two, and the middle one is the interesting one:
 *
 *   guarded   `?.member?.()` or a `Boolean(...)` availability probe.
 *             The renderer already designed for absence.
 *   contained the bare call sits inside a `try`, or the same function guards the
 *             member earlier. It throws, something catches it, and the user sees
 *             an error state — degraded, not broken.
 *   BREAKS    the bare call is reachable with no guard and no catch. The screen
 *             throws.
 *
 * The first draft of this tool reported only "guarded / not guarded" and got
 * BOTH interesting cases wrong in opposite directions:
 *   - `gateway-settings.tsx:967` was flagged BREAKS, but line 960 already does
 *     `if (!host || !window.hermesDesktop?.sshResolveHost) return`. The call is
 *     unreachable — it degrades.
 *   - the same file's `:318` really is a bare call, but inside a `try`, so it
 *     degrades too.
 * "Unguarded at the site" is not the same claim as "breaks", and conflating them
 * would have sent us fixing code that was never broken.
 *
 * Reach is computed over the REAL import graph (static AND dynamic imports),
 * seeded per screen, not by directory: `src/store/*` is imported by every
 * screen, so a cut call in a store file is genuinely on every screen's path.
 *
 * KNOWN LIMITS, stated rather than hidden:
 *   - Import parsing and function-boundary detection are regex/heuristic. A
 *     computed specifier is not followed; `export * from './x'` IS.
 *   - Only files under `src/` are walked; bare npm packages are not.
 *   - A guard in an OUTER function (or in the component's caller) counts as
 *     containment. That is deliberately generous: the question is "can this
 *     throw", and over-reporting containment hides a break, while under-
 *     reporting invents one.
 *   - Reach is static. A site behind `if (false)` still counts — deliberate,
 *     since the renderer cannot be relied on to keep it dead.
 *
 * Usage: node tools/screen-degradation.mjs [--json] [--fail-on-breaks]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { C } from './capability-classification.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')

/** The renderer screens, from src/app/routes.ts APP_ROUTES, with the route a
 * user would click. Kept as data so a report line names a destination. */
const ROUTE_SCREENS = [
  { view: 'chat', route: '/', label: 'Chat (session)' },
  { view: 'settings', route: '/settings', label: 'Settings' },
  { view: 'command-center', route: '/command-center', label: 'Command Center' },
  { view: 'capabilities', route: '/capabilities', label: 'Capabilities' },
  { view: 'messaging', route: '/messaging', label: 'Messaging' },
  { view: 'webhooks', route: '/webhooks', label: 'Webhooks' },
  { view: 'artifacts', route: '/artifacts', label: 'Artifacts' },
  { view: 'cron', route: '/cron', label: 'Cron' },
  { view: 'profiles', route: '/profiles', label: 'Profiles' },
  { view: 'agents', route: '/agents', label: 'Agents' },
  { view: 'starmap', route: '/starmap', label: 'Starmap' },
  { view: 'session-import', route: '/session-import', label: 'Session import' }
]

/**
 * Surfaces that are NOT routes and so a route-only walk misses entirely.
 *
 * This is not padding. `RootErrorBoundary` wraps the entire app and calls a cut
 * member — `window.hermesDesktop?.revealLogs()?.catch(...)`, where the `?.` is
 * on the RESULT, so `undefined()` throws. No route reaches that file, so the
 * route-only report called all twelve screens clean while the app's outermost
 * error handler was unguarded. A reachability claim is only as good as its
 * entry points, and "the screens" is not all of them.
 *
 * The four secondary windows are dynamic imports from main.tsx behind `?win=`;
 * they are separate roots in the real product and separate roots here.
 */
const OTHER_ROOTS = [
  { file: 'src/main.tsx', route: '(always mounted)', label: 'Boot + shared chrome' },
  { file: 'src/app/hud/hud-shell.tsx', route: '?win=hud', label: 'Window: HUD' },
  { file: 'src/app/pet-overlay/overlay-root.tsx', route: '?win=overlay', label: 'Window: pet overlay' },
  { file: 'src/app/quick-entry/quick-entry-root.tsx', route: '?win=quick', label: 'Window: quick entry' },
  { file: 'src/app/wake-indicator/wake-indicator-root.tsx', route: '?win=wake', label: 'Window: wake indicator' }
]

const SCREENS = [
  ...ROUTE_SCREENS.map(s => ({
    ...s,
    entry: join(SRC, 'app', s.view, 'index.tsx'),
    ownPrefix: `app${sep}${s.view}${sep}`
  })),
  ...OTHER_ROOTS.map(s => ({
    ...s,
    view: '',
    entry: join(ROOT, s.file),
    ownPrefix: relative(SRC, join(ROOT, s.file, '..')).replace(/\\/g, '/') + '/'
  }))
]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const isTest = f => /\.(test|spec)\.[a-z]+$/.test(f) || f.split(sep).includes('__tests__')
const allFiles = walk(SRC).filter(f => f.split(sep).pop() !== 'global.d.ts')

/**
 * Blanks comments and string/template bodies, preserving newlines so line
 * numbers survive. Scan CODE, not prose.
 *
 * Not cosmetic: harvesting receivers from raw text taught the matcher to accept
 * `settings` as a bridge handle (a doc comment and a test fixture did it), and
 * every `t.settings.<cut>` i18n lookup then read as a bridge reach. Half the
 * first report was that one bug. Import specifiers are read from the RAW text
 * instead, since blanking them here would delete the strings the graph needs.
 */
function stripNonCode(text) {
  const out = text.split('')
  const n = text.length
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      let j = text.indexOf('\n', i)
      if (j === -1) j = n
      blank(i, j)
      i = j
    } else if (ch === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2)
      j = j === -1 ? n : j + 2
      blank(i, j)
      i = j
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          blank(j, j + 2)
          j += 2
          continue
        }
        if (text[j] === ch) break
        if (ch === '`' && text[j] === '$' && text[j + 1] === '{') {
          let depth = 1
          let k = j + 2
          while (k < n && depth > 0) {
            if (text[k] === '{') depth++
            else if (text[k] === '}') depth--
            k++
          }
          j = k
          continue
        }
        blank(j, j + 1)
        j++
      }
      blank(i, Math.min(j + 1, n))
      i = j + 1
    } else if (ch === '/' && isRegexStart(text, i)) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) break
        else if (text[j] === '\n') break
        j++
      }
      blank(i, Math.min(j + 1, n))
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/** A `/` starts a regex literal only where a value is expected. */
function isRegexStart(text, i) {
  let k = i - 1
  while (k >= 0 && /\s/.test(text[k])) k--
  if (k < 0) return true
  return !/[A-Za-z0-9_$)\]]/.test(text[k])
}

/**
 * Block structure of the stripped text: for each `{`, what opened it, whether it
 * is a `try` body, and WHERE IT CLOSED.
 *
 * The close index is the point. A first cut treated "every `{` before this
 * offset" as enclosing, so a `try` that had already closed fifty lines earlier
 * still counted and every reach came out "contained". Mutation testing is what
 * caught it: a deliberately unguarded probe was excused by a stale `try` from
 * the top of the file. A reach is contained only if the `try` is OPEN around it.
 */
function blockInfo(stripped) {
  const blocks = []
  const stack = []
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') {
      let k = i - 1
      while (k >= 0 && /\s/.test(stripped[k])) k--
      // 400 chars of lookbehind, not 40. `if (!host || !window.hermesDesktop?.sshResolveHost) {`
      // puts `if` 60-odd characters back; a 40-char window cut it off and the
      // control-flow body still read as a function body. Widening is safe
      // because `[^{};]*` cannot cross a brace, so only a header ADJACENT to the
      // `{` can match — an `if` in an earlier statement cannot.
      const before = stripped.slice(Math.max(0, k - 400), k + 1)
      // An `if (…) {` header also ends in `)`, so a naive test classified every
      // control-flow body as a function body, which truncated the "guard earlier
      // in this function" search into the if-body.
      const controlFlowHeader = /\b(if|for|while|switch|catch|else|do)\b[^{};]*\)\s*$/.test(before)
      blocks.push({
        index: i,
        close: Infinity,
        isTry: /\btry\s*$/.test(before),
        isFunction: !controlFlowHeader && /(=>|function|\))\s*$/.test(before)
      })
      stack.push(blocks.length - 1)
    } else if (stripped[i] === '}') {
      const top = stack.pop()
      if (top !== undefined) blocks[top].close = i
    }
  }
  return offset => {
    let inTry = false
    let functionStart = null
    let functionEnd = null
    for (const b of blocks) {
      if (b.index >= offset || b.close <= offset) continue
      if (b.isTry) inTry = true
      if (b.isFunction && (functionStart === null || b.index > functionStart)) {
        functionStart = b.index
        functionEnd = b.close
      }
    }
    return { inTry, functionStart, functionEnd }
  }
}

const source = new Map()
for (const f of allFiles) source.set(f, readFileSync(f, 'utf8'))
const code = new Map([...source].map(([f, t]) => [f, stripNonCode(t)]))

/** ------------------------------------------------------------------ receivers */
/**
 * `(?![?.$])` is load-bearing: `const settings = window.hermesDesktop?.settings`
 * binds the MEMBER, not the handle. Accepting it made `settings` a receiver and
 * every `t.settings.<cut>` i18n lookup looked like an unguarded bridge reach.
 */
const receivers = new Set(['hermesDesktop'])
for (const [file, text] of code) {
  if (isTest(file)) continue
  for (const m of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?hermesDesktop(?![?.$])/g
  )) {
    receivers.add(m[1])
  }
}
const RECEIVER = [...receivers].sort((a, b) => b.length - a.length).join('|')

/** -------------------------------------------------------------- cut members */
const cuts = new Set(Object.keys(C))
const CUT_LIST = [...cuts].sort((a, b) => b.length - a.length).map(n => n.replace(/\$/g, '\\$&'))

const ACCESS = new RegExp(`\\b(?:${RECEIVER})\\b\\s*(\\??\\.)\\s*(${CUT_LIST.join('|')})\\b`, 'g')
const DESTRUCTURE = /\b\{([^}]*)\}\s*=\s*(?:window\.)?hermesDesktop\b/g

/**
 * What follows the member decides whether a missing member is survivable — NOT
 * what precedes it.
 *
 *   `hermesDesktop?.member?.()`  safe   the call is optional
 *   `hermesDesktop?.member()`    THROWS `undefined()` — the receiver's `?.` says
 *                                      nothing about the member being present
 *   `hermesDesktop.member.get()` THROWS undefined property access
 *   `const x = …?.member`       value — decided by the CONSUMER
 *
 * Two drafts got this wrong in opposite directions. Keying off the access
 * operator marked `error-boundary.tsx:188` safe — `revealLogs()?.catch(…)`
 * guards its RESULT, not its call. Keying off the call marked
 * `capturePreview?.({…})` unsafe when it is optional on both sides. Both are
 * `error-boundary.tsx` in the other direction: the report claimed all twelve
 * screens clean while the boundary wrapping the whole app threw.
 *
 * The value case needs the LOCAL, because that is where the guard lives:
 * `hud-modifier-settings.tsx` does `const api = window.hermesDesktop?.hudModifier`
 * and then `if (!api) return` three separate times before touching it. Searching
 * the function region for guards on the MEMBER name would never find those.
 */
function continuation(stripped, afterMember) {
  const rest = stripped.slice(afterMember, afterMember + 24).match(/^\s*(\?\.|\(|!|\.|\[|;|,|\)|\}|$)/)
  return rest ? rest[1] : null
}

const LOCAL_GUARD = name =>
  new RegExp(
    `(![\\s(]*\\b${name}\\b)|(\\b${name}\\b\\s*&&)|(&&\\s*[\\w?$.]*\\b${name}\\b)|(if\\s*\\(\\s*${name}\\s*\\))|(\\b${name}\\b\\s*\\?)|(\\b${name}\\b\\s*[!=]==)`
  )

/** Earlier guards for member M: optional access, a negated test, or an `&&`. */
const guardFor = member => [
  new RegExp(`\\?\\.\\s*${member}\\b`),
  new RegExp(`!\\s*[\\w?$.]*\\b${member}\\b`),
  new RegExp(`\\b${member}\\b\\s*&&`),
  new RegExp(`&&\\s*[\\w?$.]*\\b${member}\\b`)
]

const sites = []
for (const [file, stripped] of code) {
  if (isTest(file)) continue
  const at = blockInfo(stripped)
  const lineStarts = [0]
  for (let i = 0; i < stripped.length; i++) if (stripped[i] === '\n') lineStarts.push(i + 1)
  const lineOf = offset => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const record = (offset, endOffset, member, kind) => {
    const info = at(offset)
    const cont = kind === 'access' ? continuation(stripped, endOffset) : null
    // A bare CALL can only be guarded by something ABOVE it. A value BINDING is
    // guarded BELOW it — `hud-modifier-settings.tsx` does `const api = …` and
    // then `if (!api) return` three times. Searching only above made a
    // triple-guarded component read as unguarded.
    const region = stripped.slice(
      info.functionStart ?? 0,
      cont === null ? (info.functionEnd ?? stripped.length) : offset
    )

    let outcome = null
    let why = null
    if (kind !== 'access') {
      // Destructured straight off the handle: the member becomes a bare local
      // with no optional call anywhere, so it is a bare reach by construction.
      outcome = null
    } else if (cont === '?.') {
      outcome = 'guarded'
      why = 'optional chain continues past the member — undefined short-circuits'
    } else if (cont === '(' || cont === '.' || cont === '[' || cont === '!') {
      outcome = null
      why = `bare \`${cont === '(' ? 'call' : cont === '.' || cont === '[' ? 'property access' : 'assertion'}\` on a member the bridge does not define`
    } else {
      // Value use. The guard, if any, is on the local this was bound to.
      const before = stripped.slice(Math.max(0, offset - 60), offset)
      const bind = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?$/)
      const probeBefore = before.match(/(Boolean\s*\([^()]*|![^()]*|&&[^&]*|\|\|[^|]*|\?[^?]*)$/)
      if (bind && LOCAL_GUARD(bind[1]).test(region)) {
        outcome = 'guarded'
        why = `bound to \`${bind[1]}\`, which this function guards before use`
      } else if (!bind && probeBefore) {
        outcome = 'guarded'
        why = 'capability probe — the value is only tested for truthiness'
      } else if (bind && !LOCAL_GUARD(bind[1]).test(region)) {
        outcome = null
        why = `bound to \`${bind[1]}\` with no guard on it in this function`
      } else {
        outcome = null
        why = 'value used with no guard on the local'
      }
    }

    if (!outcome) {
      if (guardFor(member).some(re => re.test(region))) {
        outcome = 'contained'
        why = `${why}; guarded earlier in this function`
      } else if (info.inTry) {
        outcome = 'contained'
        why = `${why}; inside a try, so the throw becomes an error state`
      } else {
        outcome = 'BREAKS'
        why = `${why}; no guard and no catch — this throws`
      }
    }
    sites.push({ file, line: lineOf(offset), member, outcome, why, kind })
  } /** Length of the ACCESS match that starts at `offset` (member end). */
  for (const m of stripped.matchAll(ACCESS)) record(m.index, m.index + m[0].length, m[2], 'access')
  for (const m of stripped.matchAll(DESTRUCTURE)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().trim()
      if (cuts.has(name)) record(m.index, m.index, name, 'destructure')
    }
  }
}

/** -------------------------------------------------------------- import graph */
const ALIASES = [
  ['@/', join(SRC, '')],
  ['@hermes/shared/ansi', resolve(ROOT, '../shared/src/ansi.ts')],
  ['@hermes/shared/billing', resolve(ROOT, '../shared/src/billing-types.ts')],
  ['@hermes/shared/color', resolve(ROOT, '../shared/src/color.ts')],
  ['@hermes/shared/i18n', resolve(ROOT, '../shared/src/i18n.ts')],
  ['@hermes/shared/translucency', resolve(ROOT, '../shared/src/translucency.ts')],
  ['@hermes/shared', resolve(ROOT, '../shared/src/index.ts')],
  ['@hermes/plugin-sdk', join(SRC, 'sdk/index.ts')]
]
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*|\bexport\s*\*\s*from\s*)['"]([^'"]+)['"]/g

function resolveSpecifier(spec, fromFile) {
  let base = null
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else {
    for (const [prefix, target] of ALIASES) {
      // Normalise ONCE. The first cut stored the prefix as `@/` and then tested
      // `spec.startsWith(prefix + '/')` — that is `@//`, which no import ever
      // begins with, so EVERY `@/…` edge was dropped. Screens reached only their
      // relative imports, which made them look smaller and cleaner than they are.
      // Caught by checking one count by hand: /agents has 13 renderer-local
      // imports and the walk reported 3 modules.
      const p = prefix.endsWith('/') ? prefix : prefix + '/'
      if (spec === prefix || spec.startsWith(p)) {
        base = spec === prefix ? target : join(target, spec.slice(p.length))
        break
      }
    }
  }
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not this one */
    }
  }
  return null
}

const edges = new Map()
let edgesResolved = 0
let specifiersSeen = 0
for (const [file, text] of source) {
  const out = new Set()
  for (const m of text.matchAll(SPECIFIER)) {
    specifiersSeen++
    const target = resolveSpecifier(m[1], file)
    if (target && source.has(target)) {
      out.add(target)
      edgesResolved++
    }
  }
  edges.set(file, out)
}

function reachable(seed) {
  const seen = new Set()
  const stack = [seed]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f) || !source.has(f)) continue
    seen.add(f)
    for (const next of edges.get(f) ?? []) stack.push(next)
  }
  seen.delete(seed)
  return seen
}

/** -------------------------------------------------------------- per screen */
const byFile = new Map()
for (const s of sites) {
  if (!byFile.has(s.file)) byFile.set(s.file, [])
  byFile.get(s.file).push(s)
}

const at_ = s => `${relative(ROOT, s.file).replace(/\\/g, '/')}:${s.line}`

const report = SCREENS.map(screen => {
  const seed = screen.entry
  if (!source.has(seed)) throw new Error(`screen entry missing: ${relative(ROOT, seed)}`)
  const files = reachable(seed)
  const own = []
  const shared = []
  for (const [file, list] of byFile) {
    const rel = relative(SRC, file).replace(/\\/g, '/')
    if (file === seed || rel.startsWith(screen.ownPrefix)) own.push(...list)
    else if (files.has(file)) shared.push(...list)
  }
  const all = [...own, ...shared]
  const breaks = all.filter(s => s.outcome === 'BREAKS')
  return {
    route: screen.route,
    label: screen.label,
    isRoute: Boolean(screen.view),
    files: files.size + 1,
    members: [...new Set(all.map(s => s.member))].sort(),
    sites: all
      .map(s => ({ member: s.member, outcome: s.outcome, why: s.why, at: at_(s) }))
      .sort((a, b) => a.outcome.localeCompare(b.outcome) || a.member.localeCompare(b.member)),
    verdict: all.length === 0 ? 'clean' : breaks.length === 0 ? 'degraded' : 'BREAKS'
  }
})

const allSeen = new Set()
for (const screen of SCREENS) {
  allSeen.add(screen.entry)
  for (const f of reachable(screen.entry)) allSeen.add(f)
}
const unionMembers = [...new Set(sites.filter(s => allSeen.has(s.file)).map(s => s.member))].sort()
const unusedCuts = [...cuts].filter(c => !unionMembers.includes(c)).sort()

/** Members reachable ONLY from a non-route root — the always-on surface. */
const routeSeen = new Set()
for (const s of ROUTE_SCREENS) {
  const seed = join(SRC, 'app', s.view, 'index.tsx')
  routeSeen.add(seed)
  for (const f of reachable(seed)) routeSeen.add(f)
}
const alwaysOn = sites
  .filter(s => allSeen.has(s.file) && !routeSeen.has(s.file))
  .sort((a, b) => a.member.localeCompare(b.member))

/** ------------------------------------------------------------------ output */
const order = { BREAKS: 0, degraded: 1, clean: 2 }
const sorted = [...report].sort((a, b) => order[a.verdict] - order[b.verdict] || a.members.length - b.members.length)

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        report,
        unionMembers,
        unusedCuts,
        alwaysOn: alwaysOn.map(s => ({ member: s.member, outcome: s.outcome, at: at_(s) })),
        receivers: [...receivers],
        edgesResolved,
        specifiersSeen
      },
      null,
      2
    )
  )
} else {
  console.log('')
  console.log(`  Screen degradation — ${cuts.size} cut members (column C) vs the renderer that still expects them`)
  console.log(
    `  ${ROUTE_SCREENS.length} routes + ${OTHER_ROOTS.length} non-route roots · bridge handles: ${[...receivers].join(', ')}`
  )
  console.log(`  import graph: ${edgesResolved} renderer-local edges resolved of ${specifiersSeen} specifiers seen`)
  console.log('')
  for (const r of sorted) {
    const mark = r.verdict === 'clean' ? '  clean   ' : r.verdict === 'degraded' ? '  degraded' : '>>BREAKS<<'
    console.log(`${mark} ${r.route.padEnd(18)} ${r.label.padEnd(22)} ${String(r.files).padStart(4)} modules`)
    if (r.members.length) console.log(`             ${r.members.length} cut member(s): ${r.members.join(', ')}`)
    for (const s of r.sites) {
      const tag = s.outcome === 'BREAKS' ? 'BREAKS   ' : s.outcome === 'contained' ? 'contained' : 'guarded  '
      console.log(`             ${tag} ${s.member.padEnd(28)} ${s.at}  — ${s.why}`)
    }
  }
  console.log('')
  const counts = { clean: 0, degraded: 0, BREAKS: 0 }
  for (const r of report) counts[r.verdict]++
  console.log(
    `  roots: ${counts.clean} clean · ${counts.degraded} degraded · ${counts.BREAKS} that can throw unguarded`
  )
  console.log(`  cut members reachable from some root: ${unionMembers.length}/${cuts.size}`)
  if (alwaysOn.length) {
    console.log(`  reachable ONLY outside any route (${alwaysOn.length} site(s)):`)
    for (const s of alwaysOn) console.log(`             ${s.outcome.padEnd(10)} ${s.member.padEnd(24)} ${at_(s)}`)
  }
  console.log('')
}

if (process.argv.includes('--fail-on-breaks') && report.some(r => r.verdict === 'BREAKS')) process.exit(1)
