# CAPABILITY-MATRIX — what the browser client inherits, and what it drops

Phase 1 of the web/Android port. This is a reading document: no product code was
written to produce it, and nothing here is a proposal to change the renderer's
architecture without the matrix being read first.

Source of truth for the contract: the `hermesDesktop` declaration in
`src/global.d.ts` (lines 34–669), cross-checked against `electron/preload.ts`
and against the generated `tui_gateway` contract. Real
usage is measured against `src/**` — every member appears in the appendix with
its call-site count and file count.

## Verdict

The renderer is already web code, and the backend already serves almost
everything it asks the host for. **62 of 157 members need no decision at all** —
the browser speaks them unchanged because the capability already lives behind
REST or the gateway socket. **31** need a browser API written for them.
**64** have no browser equivalent and are cut, in seven named families, each with
the copy the UI shows instead.

The port replaces one object, not 157 features.

Two things only calling the server could have told us, both now measured below:
the bundle belongs on **`hermes dashboard`**, because the headless `hermes serve`
refuses three routes this matrix promises; and the WebSocket ticket path works in
gated mode but is **unreachable on loopback**, so the token-in-URL exposure is not
hypothetical — it is what the first local deployment does.

## How these numbers were counted

Three passes were run over `src/**` (2,722 `.ts`/`.tsx` files) and they disagree,
so the rule is stated before the result:

| Rule | Distinct members | Call sites | Files |
|---|---:|---:|---:|
| Spelled only — `hermesDesktop.<member>` | **128** | 390 | 163 |
| **Alias-aware** (this document) | **152** | **978** | 190 |
| Files that mention the bridge at all | — | — | **353** |

This corrects the framing the spike was handed. The renderer does **not** spell
out `window.hermesDesktop.x`; it aliases the bridge to a local (`desktop`, and
`bridge` in a few modules) and calls through that. Counting the spelled form
alone reports 128 members and silently drops 24 that really are used. 353 is the
count of files that *mention* the bridge, including type-only imports — it is an
upper bound on files, not a measure of usage.

1,191 call sites does not reproduce under any rule measured here. The naive pass
that produced it — matching bare member words — yields **71,208** hits when run
over the same 353 files (`profile` alone matches 4,128 times). Any number in that
family is an artifact. The audit uses 978 and names its rule.

Five declared members are never accessed and are therefore cut for free:
`getSecretStorageEncryption`, `agentPluginsRoot`, `getBootstrapState`,
`getSyncStatus`, `stopFindInPage`.

Two counts in the spike write-up were wrong in the same way and are corrected
here rather than carried forward: the gateway contract is **251** methods
(`RPC_METHODS`, parsed from the generated arrays — not 271), and the stub
implements **36** members, not 34.

**The floor.** The **36** members the spike stub implements (counted in the
`implemented` literal of `spike/install-bridge.ts`) are the measured minimum
to get from module load to a painted shell with a live socket — not a
convenience set. Two of them (`getConnection`, `profile.get`) were the
difference between "the renderer never submits anything" and "streaming works"
([FINDINGS.md](./spike/FINDINGS.md)).

## Hard constraint: the long-lived credential cannot cross to the browser

Measured in the spike and re-read in the server this pass:

- **REST** accepts `X-Hermes-Session-Token` as a header
  (`hermes_cli/web_server.py:377`, `_SESSION_HEADER_NAME`).
- **The WebSocket does not.** `_ws_auth_reason` (`web_server_chat.py:250`) reads
  its credential from the query string in every accepted form: `?token=` on a
  loopback bind, `?ticket=` when gated, `?internal=` for server-spawned children.
  The header is ignored.
- **One exception, and it matters:** in gated mode the browser may instead present
  a single-use ticket in the **`Sec-WebSocket-Protocol` header**
  (`_gateway_ws_ticket_from_subprotocol`, `web_server_chat.py:211`). The ticket
  is minted by the browser through an authenticated REST call, is valid 30s and
  one use, and the server answers by selecting only the stable public protocol
  back — the credential is never reflected.

So the long-lived secret never has to sit in a URL, but the browser still needs a
session it can spend: the mint call is REST, and REST is header/cookie only.
That makes one architecture **mandatory, not preferred**:

> **The client bundle is served by the Hermes backend on the same origin, and the
> session stays in an `HttpOnly` cookie. The socket credential is a short-lived
> ticket minted same-origin and presented in the subprotocol header.**

A CDN-hosted client holding a bearer token is not a variant of this design; it is
a different and unacceptable one. Holding a gateway token is equivalent to shell
access on the host, so the query-string form (`?token=`) is the fallback for local
development only — which is exactly how the spike runs.

## Scoping is a selector, and it is per-request

`?profile=` is orthogonal to auth and travels in the query string legitimately. It
is read at `chat_ws.py:285` (console) and `:462` (gateway) and resolved through
`_profile_scope` (`web_server_profiles.py:243`): a contextvar retargets config
resolution per request, while the skills modules are retargeted under one global
lock. Two tabs on different profiles therefore serialize on the skills seam
rather than corrupting config. v1 connects to one profile per tab; the port does
not inherit a per-request isolation bug, and it must not assume per-connection
isolation either.

## Column A — 62 members, already web-native

They carry no machine authority. Each is data or an RPC the backend already owns,
so the browser speaks it unchanged. The endpoint column in the appendix is not
aspiration: `/api/fs/*`, `/api/git/*`, `/api/files/*`, `/api/profiles/*`,
`/api/hermes/update*`, `/api/pty`, `/api/env/reveal`, `/api/dashboard/plugins*`
and `/api/host/identity` are **216 measured REST/WS routes**
(`hermes_cli/web_routers/**` + `web_server.py`) that already exist.

The two findings that changed this audit most:

- **`git` is not a migration risk.** The earlier draft of this matrix called it
  the largest open item on the theory that 890 call sites would need a spike.
  `/api/git/*` already maps 1:1 onto all ten `git.*` members *and* the entire
  `git.review.*` sub-surface — stage, unstage, revert, commit, push, create-pr,
  pr-list, ship-info, commit-context. The item is closed by measurement. (The 890
  figure was the refuted naive count; the measured namespace access is 7.)
- **`terminal` is not a cut.** `/api/pty` and `/api/tools/terminal/backend`
  already serve it over the same WebSocket the dashboard uses. Re-hosting, not
  porting.

One member in this column needs a home that does not exist yet:
`connections` (10 members, 22 call sites, 19 files). Its persistence is
`app.getPath('userData')/connections.json` — Electron `userData`, readable by no
browser and served by no route. This is the only place where the port needs new
backend surface (a small registry endpoint mirroring that file), or an explicit
decision to keep the endpoint list per-browser. It is called out below, not
buried.

## Column B — 31 members with a browser equivalent

A browser API exists, but not a free one. Each needs an implementation and the
caveat in the appendix has to be designed for, not discovered: clipboard needs
transient activation and a secure context; `Notification` is denied by default on
Android, so push is the only durable answer; File System Access is Chromium-only,
so Firefox and Safari need `<input type=file>` or a server-side file route;
`getDisplayMedia` requires the user to pick a surface; the Battery Status API is
**deprecated and Chromium-only** and ships as unavailable.

The rule that survives from `AGENTS.md`: *window.open only ever happens behind a
user click, never on behalf of preview content.*

## Column C — 64 members, closed

Nothing in this column is waiting for approval. Each family states what the user
sees instead, per the repo's own rule (`AGENTS.md:124-127`): *empty, loading,
reconnecting, degraded/stale, and exhausted-recovery each deserve their own
honest copy and their own way out.* No member in this column is left as a stub
that renders and does nothing.

| Family | Members | Cut | What the user sees |
|---|---:|---|---|
| **C1** Window chrome and multi-window IPC | 10 | Custom titlebar, traffic lights, pop-out windows, cross-window relay, embed-host origin | The browser frame is the frame. "Open in a new window" becomes "open in a new tab" (a link); the pop-out Browser button becomes that link. One window, so nothing has to coordinate. |
| **C2** Always-on-top overlay windows | 6 | HUD, pet, wake indicator, Quick Entry, hud modifier, onboarding window | Removed, not half-rendered. Quick Entry exists only as a documented in-page shortcut; the global chord is listed as unavailable. |
| **C3** Native theming and glass | 5 | Titlebar/native theme, translucency, `glassSupported`, `translucencySupported` | The web theme governs the surface. The two fact members report a constant so the renderer's own capability branches take the "unsupported" path instead of guessing. |
| **C4** DevTools / F12 and Electron input | 8 | F12 toggles, preview-shortcut flag, guest-hidden flag, `stopFindInPage`, open-find-bar and open-updates menu routes | The browser owns F12 and Ctrl+F. The FindBar is removed and Ctrl+F documented; Desktop-only toggles are hidden rather than shown dead. |
| **C5** Preview `<webview>` internals | 5 | Guest crop, guest + host spellcheck dictionary, close-preview-request | Previews become sandboxed iframes. The two with no equivalent at all report an explicit "Not available in the browser client" — never an empty image or a silent no-op. |
| **C6** Host lifecycle, bootstrap, packaging | 22 | Tray, relaunch, uninstall, pool sizing/keepalive, backend exit/retire/applied events, the whole bootstrap cluster, crash metrics, remote-display reason | A browser attaches to a gateway somebody else runs. Bootstrap collapses into one "Connect to a Hermes gateway" form; Settings reads "Managed on the host" where a Desktop-only action used to sit; the status bar reads "Gateway offline — retrying" with its countdown, because the socket close is the only signal a browser gets. |
| **C7** Host resources out of reach | 8 | SSH config, OS trash, OS keychain, `read_window_below`, host log lines | Each shows "Not available in the web client" with the reason, instead of an empty list that reads as a bug. |

Two members deserve a note because they look like cuts and are not:

- **`contextMenuSpellcheck` (C5)** — the browser's own context menu and
  spellcheck apply; the composer sets `spellcheck` attributes. The OS dictionary
  verbs are the part that is gone.
- **`getSecretStorageEncryption` / `setSecretStorageEncryption` (C7)** — secrets
  belong to the gateway that holds them. Settings states that they are stored by
  the host rather than offering a toggle that cannot protect anything in a
  browser.

## The gateway surface the matrix is written against

The renderer does not talk to the backend directly; it talks to one funnel
(`api` for REST, plus the `tui_gateway` WebSocket).

| Surface | Count | Where it goes |
|---|---:|---|
| JSON-RPC over `tui_gateway` | **251** methods (`RPC_METHODS`) | Unchanged — same socket, same contract. |
| Server-initiated requests | **13** (`SERVER_REQUEST_METHODS`) | Unchanged — the browser subscribes over the same socket. |
| Gateway event types | **75** (`GATEWAY_EVENT_TYPES`) | Unchanged — parsed by the same envelope handler. |
| REST + WebSocket routes | **216** | Unchanged, same-origin behind the backend. |
| `?profile=` scoping | query param | Unchanged; per-request contextvar with one global skills lock. |
| The bridge itself | **157** declared / **152** used | **This is the only thing the port replaces.** |

The audit's real finding is not the size of the bridge — it is that the bridge is
not a thin capability layer. 40 nested namespaces, 43 event subscriptions that
return an unsubscribe (23 top-level, 20 nested), rich structured returns
(`connections`, `updates`, `getPoolLimits`, `hud`), and a single member (`api`)
carrying 101 of the 978 call sites. Underneath it, most of the surface is
already backend-owned. The client is a reimplementation of one object with a
typed return for every member the boot path touches.

## What Phase 2 has to build (not a cut — a scope)

Both items below were open when this section was first written; the measured
sections that follow now answer them. What is left is short:

1. **A registry home for `connections`** — one small server endpoint mirroring
   `connections.json`, or an explicit per-browser list with the limitation stated
   in Settings. See *`connections` — closed, on measurement*.
2. **Deploy on `hermes dashboard`, not `hermes serve`.** The headless server
   refuses three routes the matrix promises. This is a one-line deployment
   decision, not work.
3. **A real gated handshake, end to end.** The parse rule and the ticket store are
   proven; the accept path needs an auth provider registered, which this machine
   does not have. Loopback is unavoidable in development and its `?token=` path
   puts a credential in the URL — so the client must ship with loopback labelled a
   development mode. See *the gated ticket leg*.

## Phase 2 — the WebBridge, as built and as measured

The bridge replaces the spike's hand-written `Proxy`. It lives in its own
package, `apps/desktop/packages/web-bridge` (`@hermes/web-bridge`), and is a
plain object literal — no `get` trap, no `has` trap, no placeholder: every one
of its members is either a real same-origin transport or a browser API that
genuinely works, and the rest are **absent** so the renderer's own
optional-chaining guard takes the "not here" branch.

It is a package rather than app code because it has no React, no Electron and no
renderer import — nothing in it needs the Desktop app to exist. That makes it
directly testable, which is the point: see *What the package's tests catch* below.

**43 of 157 members are live** (37 transport, 6 browser); **114 are cut**. The
other 60 column-A members are web-native in principle and not yet wired — the
audit prints that number every run as `transport debt`, so it cannot quietly
become 61.

Three properties are enforced, not promised. `tools/audit-contract.mjs` fails
the build when:

- a declared member is neither implemented nor marked a cut (`BRIDGE INCOMPLETE`)
- a member is marked a cut *and* implemented (`BRIDGE CONTRADICTION`)
- a cut carries no user-facing copy (`CUT WITHOUT COPY`)
- an implemented member names no endpoint (`NO ENDPOINT STATED`)
- the bridge implements something the contract does not declare (`BRIDGE EXTRA`)
- the ledger and the generated manifest disagree with the classification
  (`LEDGER LENGTH`, `BRIDGE MANIFEST STALE`)
- a member is **present with an `undefined` value** (`BRIDGE PLACEHOLDER`)

That last one is the original bug wearing a disguise. `settings.pickDefaultProjectDir`
was required by the contract, so it could not simply be deleted — and it had
been written as `undefined as never`, which passes an `in` check and a key count
while answering nothing. The gate now walks the built object (nested namespaces
included) and fails on any `undefined`-valued key. A top-level-only check would
have missed it: the offender was one level down.

`IMPLEMENTED_MEMBERS` is **derived** from the bridge object, not maintained
beside it. A hand-written list is a second source of truth, and it drifted once
already: deleting a member from the object left it listed as implemented and the
audit passed. Reading the keys off the object makes "implemented" and "present"
the same fact.

`capabilities()` is what the UI asks instead of probing members with `in`, which
is what the spike's Proxy made impossible: `{ bridge, missing, kindOf, surfaces }`.

### The terminal: measured, and it is not what the first draft assumed

The bridge's first `PtySocket` spoke a JSON envelope it had invented
(`{type:'start'|'input'|'resize'}`). That was wrong, and only the wire could say
so. `/api/pty` (`hermes_cli/web_routers/chat_ws.py`) is a **raw byte pump**:
`ws.send_bytes(chunk)` outbound, `msg["bytes"]` inbound. The invented JSON
would have been written straight into the child's stdin as literal text — a
socket that opened, spawned a TUI, and could not be typed into.

What the client sends, measured:

| | |
|---|---|
| frames both ways | raw bytes, no envelope |
| resize | in-band `\x1b[RESIZE:<cols>;<rows>]`, consumed server-side, and **only when it is the whole frame** (`_RESIZE_RE` + `match.end() == len(raw)`) — appended to a keystroke it reaches the PTY as text |
| the child | `hermes --tui`, not a shell |
| JSON the server sends | `{"type":"resume","id":…}`, an implicit session replay |
| start failure | human-readable text, then close 1011 |
| auth | the same `?token=` query leg as `/api/ws` |

Exercised through the bridge's own `terminal` member in a real browser against
the live gateway: **6229 bytes** of TUI screen on start, a typed keystroke grew
the stream, a resize produced a full redraw (7815 → 12692 bytes, which is what
proves the server consumed the escape rather than echoing it), and `dispose`
closed the socket. `cwd` returns `null` — the Desktop contract already scopes
that probe to POSIX, and there is no child handle here to ask.

## Measured: the routes this matrix promises, actually called

Reading route names is not evidence. Every promise below was exercised against
two live servers on this machine: `hermes serve` on `:9119` (headless, already
running) and `hermes dashboard --isolated` on `:9120`, both Hermes **0.21.5+7353**,
authed with `X-Hermes-Session-Token: spike-token-123`, paths pointing at this repo.
Repo HEAD and the installed build declare the **same 216 routes** (verified by
diffing the two route tables — no version skew), so a 404 below is about the
*call*, not the build.

**The first finding is which server you deploy on.** `hermes serve` is headless and
refuses part of the surface the matrix relies on:

| Route | `serve` :9119 | `dashboard` :9120 |
|---|---|---|
| `/api/dashboard/agent-plugins*` | 404 `web UI disabled — use \`hermes dashboard\`` | 200 |
| `/api/tools/terminal/backends` | 404 same | 200 `{"active":"local",…}` |
| `/api/ops/doctor` | 404 same | 200 `{"ok":true,…}` (POST) |

> **The client bundle belongs on `hermes dashboard`, not `hermes serve`.** The
> Phase 0 spike pointed the renderer at `hermes serve` and that choice would have
> shipped a client missing three capabilities it has already been promised.

Confirmed working on the dashboard server, with real payloads — this is the
evidence behind Column A, not a promise:

| Route (method) | Status | Returns |
|---|---:|---|
| `/api/fs/list` (GET) | **200** | real `entries[]` |
| `/api/fs/read-text` (GET) | **200** | `byteSize`, `language`, `mimeType` |
| `/api/fs/read-data-url` (GET) | **200** | `data:text/markdown;base64,…` |
| `/api/fs/git-root` (GET) | **200** | repo root |
| `/api/git/status` (GET) | **200** | `branch: spike/web-renderer`, ahead/behind/staged |
| `/api/git/branches` (GET) | **200** | local + remote branches |
| `/api/git/base-branches` (GET) | **200** | branches, `isDefault` flagged |
| `/api/git/worktrees` (GET) | **200** | worktree list |
| `/api/git/file-diff` (GET) | **200** | unified diff |
| `/api/git/review/list` (GET) | **200** | changed files with add/remove counts |
| `/api/git/review/diff` (GET) | **200** | per-file diff |
| `/api/git/gh-auth` (GET) | **200** | `{"available":false}` — no `gh` on this host |
| `/api/profiles`, `/api/profiles/active` (GET) | **200** | roster + active |
| `/api/hermes/update/check` (GET) | **200** | version, behind, `update_available` |
| `/api/dashboard/themes`, `/font`, `/plugins`, `/plugins/rescan` (GET) | **200** | themes, font, plugin list, `{ok,count:2}` |
| `/api/mcp/servers`, `/api/providers/oauth`, `/api/files`, `/api/chat/workspaces`, `/api/pairing`, `/api/env`, `/api/skills`, `/api/config`, `/api/status`, `/api/health`, `/api/host/identity`, `/api/local-models/status` (GET) | **200** | see the sweep in this commit's message |

Honest negatives — routes that do **not** deliver what Column A claimed:

| Route | Status | Consequence for the matrix |
|---|---:|---|
| `/api/ssh/ownership` | 404 `SSH ownership is not active` | The feature is off. `sshConfigHosts` / `sshResolveHost` have **no working** server equivalent — the C7 cut is now measured, not assumed. |
| `/api/media/proxy?url=https://example.com` | **403** `Image host not allowed` | It is an allowlisted proxy, not an open one. `resolveFavicon` and `saveImageFromUrl` (Column B) must design for an allowlist. |
| `/api/ops/doctor` (GET) | 404/405 | It is **POST**-only. My first sweep reported this as a missing route; the real answer was my method. |
| `/api/files/download` | 422 missing `path` | Exists; I called it wrong. |

That correction is worth stating plainly: **four "missing routes" in my first
sweep were four method errors on my side** (`/api/ops/doctor` is POST,
`/api/fs/read-data-url` is GET, `/api/dashboard/agent-plugins` has no GET
collection, `/api/tools/terminal/backend` is PUT). Had I recorded them as missing,
the matrix would have shipped four false cuts. Not called at all, because they
mutate host state: `PUT /api/tools/terminal/backend`, `POST /api/gateway/restart`,
`POST /api/gateway/stop`, `POST /api/fs/write-text`, `POST /api/files/mkdir`, and
`GET /api/env/reveal` (it opens the OS file manager).

## Measured: the gated ticket leg — the decisive question

The Phase 2 design stands or falls on whether a browser can open `/api/ws` without
putting a long-lived credential in a URL. Three facts, each measured:

**1. The parse rule (real function, executed from the shipped source).**
`_gateway_ws_ticket_from_subprotocol` with the real constants
(`hermes-gateway-v1`, prefix `hermes-gateway-ticket.`):

| `Sec-WebSocket-Protocol` sent | Result |
|---|---|
| `hermes-gateway-ticket.<t>, hermes-gateway-v1` | `('<t>', 'ok')` |
| `hermes-gateway-v1, hermes-gateway-ticket.<t>` (reversed) | `('<t>', 'ok')` — order-independent |
| ticket protocol **alone** | `('', 'invalid')` |
| public protocol alone | `('', 'none')` |
| **two** ticket protocols | `('', 'invalid')` |
| prefix with an empty ticket | `('', 'invalid')` |

A ticket can never travel without the public protocol, and two of them is an
error. The credential is carried in a **header**, never a URL, and never
reflected back — the accept path answers with `_GATEWAY_WS_PROTOCOL` only.

**2. The ticket lifecycle (real `ws_tickets.py`).** `TTL_SECONDS = 30`. A minted
ticket (43 chars) consumes once with `{user_id, provider}`; the second consume is
rejected `unknown ticket`; a ticket past its TTL is rejected `expired`. Single-use
and time-boxed, as documented.

**3. The mint endpoint is unreachable outside gated mode — and that is the
finding.** `POST /api/auth/ws-ticket` returned **401** on *both* live servers
even with a valid session-token header. `_require_session` reads
`request.state.session`, which only the auth gate sets; on a loopback bind the
gate is off and no session is ever established. And gated mode is not something a
client can opt into: `should_require_auth` is `host not in _LOOPBACK_HOST_VALUES`,
and `--insecure` is documented as **DEPRECATED / NO-OP** — a public bind always
requires a real password or OAuth provider.

> **Conclusion, and it sharpens the plan.** The header ticket path is sound *in
> gated mode*, and a browser can use it there: cookie session → `POST
> /api/auth/ws-ticket` → subprotocol handshake. But **the first deployment anyone
> runs is loopback, where the ticket endpoint is 401 and the only working
> credential is `?token=` in the query string.** Same-origin + `HttpOnly` cookie
> is therefore not merely preferable — it is the *only* design that makes a public
> bind safe, and it does nothing for loopback, where the token sits in the URL by
> necessity. The Phase 2 client must treat loopback as a development-only mode and
> say so, rather than let the local path become the shipped default.
>
> Not exercised end-to-end: a real gated handshake needs an auth provider
> registered, and this machine has none (providers come from plugins via
> `auth_plugin_providers.py`). Standing one up — or binding a non-loopback host,
> which would expose this gateway on the network — is a decision for the user, not
> something this audit should do unasked. What is proven above is the shipped code
> text for the parse and the ticket store; the accept path itself is covered by
> the repo's own `tests/hermes_cli/test_dashboard_auth_ws_auth.py`, which I could
> not run here (no `pytest`/`fastapi` in this Python, and the Hermes launcher is a
> compiled binary with no importable venv).

## `connections` — closed, on measurement

Ten members, 22 call sites, 19 files. Persistence is
`app.getPath('userData')/connections.json` — Electron `userData`, readable by no
browser and served by no route. Called on the dashboard server, the nearest
surfaces are:

| Route | Status | What it actually is |
|---|---:|---|
| `/api/profiles` | 200 | HERMES_HOME profiles, not connection *sources* |
| `/api/profiles/active` | 200 | the active profile name |
| `/api/chat/workspaces` | 200 | `{projects, repos, default_cwd, home}` — repos, not registry entries |

So the registry itself has **no server home**, and `/api/profiles` is not a
substitute: a registry entry is a dialable source (local / remote / cloud / ssh)
with its own auth material, which is a different shape from a profile name. The
column closes like this:

- **The port needs one small backend endpoint** mirroring `connections.json` —
  list/save/remove/set-primary plus the existing `onChanged` push. It is the only
  new server surface the whole matrix requires.
- **Until it exists, the honest v1 behaviour is per-browser**: the endpoint list
  lives in the browser, and Settings states that plainly — *"Your gateway list is
  stored in this browser only. Add the same gateway on another device to use it
  there."* That is degraded-with-copy, not a silent divergence.
- **`connections.test` has a real equivalent** (`/api/profiles/…`, `/api/status`
  reachability) so testing a saved entry is not blocked by the missing registry.
- Not a cut: the capability is core. Not a cut by accident either: the renderer
  branch on `connections.list` returning an empty registry is the honest state, and
  the renderer already treats an absent member as tolerable.

### What the package's tests catch

48 tests run in `npm run check` (`check:web-bridge`), covering the two
string-handling paths where a subtle bug cost a debugging cycle, plus the
capability invariants above.

A test that passes against broken code is worse than no test, so each of the
three regressions this port actually shipped was **reintroduced** to confirm the
suite catches it:

| Reintroduced bug | Caught by |
|---|---|
| `scheme + '//' + origin` — the socket URL parsed with host `http` | 10 URL tests fail |
| `profile=${String(scope)}` — the literal `undefined` in the query | 3 scope tests fail |
| `pickDefaultProjectDir: undefined as never` | `has no key whose value is undefined` |

Two of those mutations first **passed**, and both times the mutation was wrong
rather than the test. `const profile = scope` is absorbed by the `profile ? …`
truthiness guard downstream, so it never produced the bug; and inserting
`pickDefaultProjectDir: undefined` as a *duplicate* key left the real
implementation to overwrite it. A duplicate key that shadows nothing is a
different bug — silent — and is worth its own audit check.

### Open: the gated ticket leg is still unproven

`POST /api/auth/ws-ticket` answers **401 on loopback** even with a valid header,
so the single-use `Sec-WebSocket-Protocol` ticket exchange has never been
exercised end to end against a real public bind. The client half is therefore
**not written**: it would be code shaped by guesswork about a handshake nobody
has observed succeed. This stays the largest open item in the port, and the
loopback `?token=` path it falls back to in development puts a credential in the
URL — so loopback must ship labelled a development mode.

## Keeping this document true

```bash
npm run check:contract                  # wired into `npm run check`; exit 1 on any drift
node tools/audit-contract.mjs --write   # verify, then regenerate appendix + bridge manifest
```

`--write` regenerates **two** files: this document's appendix and
`packages/web-bridge/src/manifest.ts`. The manifest used to be produced by a
scratch script kept outside the repo, which is how `terminal` went on claiming
`GET /api/pty` long after the wire protocol had been measured. One writer, one
source.

The generator runs its own output through the project's prettier before
comparing. It has to: the audit wrote a file prettier then reformatted, and the
next run called the audit's own output stale. A generator that fights the
formatter teaches people to ignore both.

A gate nothing runs is not a gate, so `check:contract` is the first step of
`npm run check`: a change to the bridge that is not reclassified fails the chain
before lint or a single test runs.

`tools/capability-classification.mjs` holds the classification as data;
`tools/audit-contract.mjs` is the gate. It regenerates the appendix below from
`src/global.d.ts` and `electron/preload.ts` and **exits non-zero** when a member
is added without a column, when one is classified twice, when a cut has no family
or a family has no copy, when a key names a member that no longer exists, when an
A/B member has no stated replacement, or when a row in the generated region has
been hand-edited, and when the bridge and the ledger disagree about a member.
The failure modes are demonstrated by re-breaking them, not asserted.

`--write` reports problems but does not exit before regenerating. Several
failures — a member classified as a cut while the bridge serves it, a member
with no endpoint — are exactly what regenerating repairs, so exiting first made
`--write` unable to fix its own failures. The exit code is still 1.

**Ten members moved out of Column C during Phase 2**, and that is the audit
working rather than the audit bending. `onBackendExit`, `onBootProgress`,
`onBootstrapEvent`, `getPoolLimits`, `setPoolLimits`, `getBootProgress`,
`getBootstrapState`, `glassSupported`, `translucencySupported` and
`getRecentLogs` were all classified "cut" in the first draft. They are not
optional in the contract and the renderer calls several of them **unguarded at
module load** — so cutting them threw during import and the app never finished
booting. That is exactly what the first real-bridge run showed. Each is
genuinely answerable (a constant, a live subscription, a rejected write), so
"cut" was never the honest description; they are Column A now, each naming what
backs it.

`getRecentLogs` deserves the note: it is **not** the host's log files. Those stay
C7 — `/api/ssh/ownership` measured 404 `SSH ownership is not active`. The
bridge returns the renderer-visible trace ring buffer and reports
`path: "in-page"`, so the source can never be mistaken for a file on disk.

It also reports something the hand-written version could not: **preload.ts
implements 155 of the 157 declared members.** The two it does not are
`agentPluginsRoot` and `getSyncStatus` — both also among the five the renderer
never calls. Three independent sources agreeing is the point of the gate: the
contract declares them, Electron never implemented them, the renderer never uses
them, and Column C says so without anyone having to remember.

It also caught a bug in the throwaway extractor the earlier draft of this document
was built from: that script searched for `hermesDesktop` at six spaces when it is
declared at four, so it silently scanned the head of `global.d.ts` and produced
the right answer by luck. The committed appendix is parsed from the real block and
reports the same 157 / 152 / 978 — so the numbers survived, but they no longer
depend on the accident.

## Appendix — all 157 members

Every declared member, exactly one column. `Uses` and `Files` are measured over
`src/**`; `(n members)` is the namespace's nested member count, included in the
157 by contract but not counted again in the row's use total.
<!-- BEGIN GENERATED APPENDIX -->
<!-- generated by tools/audit-contract.mjs --write; do not hand-edit -->

#### Column A

| Member | Uses | Files | Endpoint / equivalent |
|---|---:|---:|---|
| `api` | 101 | 39 | The REST funnel. One function to reimplement; 101 measured call sites behind it. |
| `getConnection` <br>_(2 members)_ | 99 | 20 | Gateway socket handle. Boot-critical — without it the renderer never submits. |
| `profile` <br>_(6 members)_ | 56 | 24 | /api/profiles/active + ?profile=; `set` becomes client state plus the profile selector. |
| `getConnectionFor?` <br>_(3 members)_ | 52 | 14 | Same socket, registry-scoped. |
| `readFileDataUrl` | 38 | 14 | GET /api/fs/read-data-url — measured 200 with a real data URL. |
| `getGatewayWsUrl` | 26 | 3 | Mints the socket URL. Boot-critical. |
| `connections` <br>_(10 members)_ | 22 | 19 | NO SERVER HOME. See the connections section of the matrix: the registry is Electron userData (connections.json), unreadable by any browser and served by no route. /api/profiles and /api/chat/workspaces cover neighbours, not the registry. |
| `getGatewayWsUrlFor?` <br>_(2 members)_ | 21 | 7 | Registry-scoped mint. Boot-critical; the renderer branches on its presence. |
| `cloud` <br>_(5 members)_ | 19 | 6 | Portal login round-trip; discovery is a REST call. |
| `applyConnectionConfig` | 14 | 6 | Re-dial against the new descriptor. |
| `probeConnectionConfig` | 14 | 6 | Server-side reachability probe. |
| `saveGatewayFile?` <br>_(8 members)_ | 13 | 6 | GET /api/files/download — the HOST writes; the browser needs no path picker. |
| `readDir` | 12 | 3 | GET /api/fs/list — measured 200 with real entries. |
| `getBootProgress` | 11 | 2 | Reports `running:false, progress:1` — a browser client attaches to a gateway somebody else installed, so it is ready the moment the socket opens. |
| `testConnectionConfig` | 11 | 5 | Reachability probe against the saved descriptor. |
| `updates` <br>_(8 members)_ | 11 | 4 | GET /api/hermes/update/check — measured 200. Branch/packaging members are Desktop-only and get no UI. |
| `getAgentRoster?` | 10 | 7 | Union roster over registered connections → /api/profiles. |
| `oauthLoginConnectionConfig` <br>_(2 members)_ | 10 | 6 | URL round-trip; the callback lands same-origin. |
| `getConnectionConfig` | 7 | 5 | The descriptor is built client-side from the endpoint URL the user typed. |
| `oauthLogoutConnectionConfig` | 7 | 5 | GET /api/providers/oauth |
| `sanitizeWorkspaceCwd` | 7 | 4 | Server-side sanitiser already exists. |
| `settings` <br>_(3 members)_ | 7 | 4 | /api/fs/default-cwd (get/set). |
| `revealLogs` | 7 | 7 | /api/env/reveal |
| `git?` <br>_(10 members)_ | 7 | 6 | GET /api/git/* — measured 200 for status, branches, base-branches, worktrees, file-diff and review/list + review/diff. The full review pane (stage/unstage/revert/commit/push/create-pr/pr-list/ship-info/commit-context) is declared 1:1 in hermes_cli/web_routers/git.py. |
| `zoom?` <br>_(4 members)_ | 6 | 4 | Client-side; the browser owns zoom. |
| `gitRoot?` | 6 | 3 | GET /api/fs/git-root — measured 200 with the repo root. |
| `getProfileRoutes` | 4 | 2 | Credential-free routes → /api/profiles/active. |
| `saveConnectionConfig` | 4 | 3 | Client-side persistence of the endpoint entry. |
| `dataUrlReadMax?` <br>_(2 members)_ | 4 | 2 | Server cap + a client pref. |
| `normalizePreviewTarget` | 4 | 3 | Pure URL logic — runs in the browser as-is. |
| `stopPreviewFileWatch` | 4 | 2 | Client-side handle teardown. |
| `glassSupported?` | 4 | 2 | Reports a constant `false`: the browser frame is not a native window. A real fact the renderer branches on, not a stub. |
| `logLine?` | 4 | 3 | POST /api/ops/doctor / /api/ops/debug-share. |
| `revealPath?` | 4 | 3 | /api/env/reveal |
| `themes` <br>_(2 members)_ | 4 | 3 | GET /api/dashboard/themes + /api/dashboard/font — both measured 200. |
| `readPluginSource?` | 3 | 2 | GET /api/config/raw and /api/dashboard/agent-plugins/{name}. |
| `openDir?` | 3 | 3 | /api/env/reveal |
| `desktopPluginsRoot?` | 3 | 3 | GET /api/dashboard/plugins |
| `reconcileDesktopPlugins?` | 3 | 3 | GET /api/dashboard/plugins/rescan — measured 200 {ok,count}. |
| `terminal` <br>_(8 members)_ | 3 | 2 | /api/pty over WebSocket, measured live: raw PTY bytes both ways (not a JSON envelope) and an in-band [RESIZE:cols;rows] escape the server consumes when it is the whole frame. The child is `hermes --tui`, not a shell. 15262 bytes of real TUI screen on a cold dial. GET /api/tools/terminal/backends answers the probe (measured 200). |
| `probePluginRepo?` <br>_(8 members)_ | 3 | 2 | GET /api/dashboard/plugins/catalog |
| `installDesktopPlugin?` <br>_(3 members)_ | 3 | 2 | POST /api/dashboard/agent-plugins/install |
| `onPreviewFileChanged` | 3 | 2 | Same poll/events seam as watchPreviewFile. |
| `readFileText` | 2 | 1 | GET /api/fs/read-text — measured 200 with byteSize/language/mimeType. |
| `watchPreviewFile` | 2 | 2 | No OS watcher in a browser: poll /api/fs/read-text or ride /api/events. |
| `watchDirectory?` | 2 | 1 | Same poll/events seam as watchPreviewFile. |
| `translucencySupported?` | 2 | 1 | Reports a constant `false`: there is no native chrome to make translucent. |
| `onExternalOpenFailed?` | 2 | 1 | Client-side error state; the browser reports a blocked pop-up itself. |
| `mcpOauth?` <br>_(3 members)_ | 2 | 2 | /api/mcp/oauth/flows/{flow_id} + /api/mcp/oauth/callback/{server_name}. |
| `reportRendererError?` <br>_(4 members)_ | 2 | 2 | POST /api/ops/doctor — measured 200. |
| `logsRoot?` | 2 | 1 | /api/env/reveal |
| `writeTextFile?` | 2 | 1 | POST /api/fs/write-text |
| `reachPreviewUrl?` | 2 | 2 | URL resolution — client-side. |
| `removeDesktopPlugin?` | 2 | 2 | DELETE /api/dashboard/agent-plugins/{name} |
| `probeLocalBackend?` | 2 | 2 | GET /api/health answers "is a gateway already up" — measured 200. |
| `recycleBackend?` | 2 | 2 | POST /api/gateway/restart |
| `onBootstrapEvent` | 2 | 1 | Live subscription with no host source, for the same reason as getBootstrapState. |
| `getVersion` | 2 | 2 | GET /api/status — measured 200. |
| `getMachineProfile?` | 2 | 2 | GET /api/host/identity — measured 200. |
| `getPoolLimits` | 1 | 1 | Client-side constant: this client owns no backend pool, so it reports one gateway. |
| `setPoolLimits` <br>_(2 members)_ | 1 | 1 | Rejected with `ok:false` and the current limits: the pool belongs to the host running the gateway. |
| `claimStartupLatency?` | 1 | 1 | Client-measurable (performance.now) — no host fact needed. |
| `readFileDataUrlForAttach?` | 1 | 1 | GET /api/fs/read-data-url (the server enforces the lower cap). |
| `localModelsEnabled?` | 1 | 1 | GET /api/local-models/status — measured 200. |
| `guestOnboardingEnabled?` | 1 | 1 | A launch flag the web client no longer sets: read it from the gateway it attached to. |
| `localSkin?` | 1 | 1 | Sanitized config the browser reads from /api/config. |
| `getRecentLogs` | 1 | 1 | In-page trace ring buffer fed by logLine. `path` reports "in-page" so it is never mistaken for the host log files. |
| `setActiveConnectionRoute?` <br>_(1 members)_ | 1 | 1 | Client-side route state. |
| `onOpenFolderRequested?` | 1 | 1 | Becomes a route plus /api/env/reveal. |
| `onBackendExit` | 1 | 1 | Real subscription fed by the gateway socket close — the only exit signal a browser client gets. |
| `onBootProgress` | 1 | 1 | Live subscription with no host source: nothing to install means nothing to report. |
| `getBootstrapState` | 0 | 0 | Reports `active:false`: bootstrap is inapplicable to a client that attaches to a running gateway. |

#### Column B

| Member | Uses | Files | Endpoint / equivalent |
|---|---:|---:|---|
| `openExternal` | 45 | 31 | anchor / window.open behind the click gate (see the guest-content rule). |
| `openPreviewInBrowser?` | 10 | 3 | window.open with noopener behind a user click. |
| `saveImageBuffer` | 9 | 5 | anchor + download. A real download, no silent path. |
| `writeClipboard` | 8 | 7 | navigator.clipboard.write — needs transient activation. |
| `notify` | 6 | 4 | Notification API — denied by default on Android; push is the only durable answer. |
| `selectPaths` | 6 | 4 | showOpenFilePicker (Chromium) / <input type=file> elsewhere. |
| `screenshot?` | 5 | 5 | getDisplayMedia — the user must pick a surface; no silent capture. |
| `selectSavePath?` <br>_(3 members)_ | 4 | 3 | showSaveFilePicker (Chromium) / anchor download elsewhere. |
| `saveImageFromUrl` | 4 | 2 | anchor + download. /api/media/proxy measured 403 for a non-allowlisted host, so the allowlist is part of the design. |
| `getPathForFile` | 4 | 2 | File / FileReader, Blob URLs — drag-and-drop attach works natively. |
| `onFoundInPage` | 3 | 2 | Custom Highlight API counters (Chromium). |
| `readClipboard` | 2 | 2 | navigator.clipboard.read — needs transient activation. |
| `contextMenuCopyImage?` | 2 | 2 | Canvas → data URL → clipboard. |
| `savePastedText` | 2 | 2 | anchor + download. |
| `setActiveWork?` | 2 | 2 | Web App Badges (Chromium-only) / document.title fallback. |
| `setKeepAwake?` | 2 | 2 | Screen Wake Lock — active tab only, released when backgrounded. |
| `onDeepLink?` <br>_(1 members)_ | 2 | 2 | URL query/hash — a bookmarkable link, not an OS protocol handler. |
| `onPowerResume?` | 2 | 2 | visibilitychange — an approximation, not a real power event. |
| `requestMicrophoneAccess` | 1 | 1 | getUserMedia — needs HTTPS and a permission prompt. |
| `contextMenuEdit?` | 1 | 1 | Clipboard API against the focused element. |
| `saveClipboardImage` | 1 | 1 | navigator.clipboard.read image + download. |
| `fetchLinkTitle` | 1 | 1 | fetch + oEmbed — CORS-bound; degrades to the bare URL. |
| `resolveFavicon?` | 1 | 1 | GET /api/media/proxy behind an allowlist — measured 403 off-allowlist, not an open proxy. |
| `onPreviewNav?` | 1 | 1 | iframe + postMessage — a cross-origin frame cannot be driven. |
| `signalDeepLinkReady?` | 1 | 1 | Client-side handshake once the deep link is parsed. |
| `onFocusSession?` | 1 | 1 | visibilitychange + focus events. |
| `onNotificationAction?` | 1 | 1 | Notification.onclick — works, but only while the tab lives. |
| `onNotificationActivate?` <br>_(1 members)_ | 1 | 1 | Notification.onclick. |
| `getOnBattery?` | 1 | 1 | Battery Status API — DEPRECATED and Chromium-only. Ship as unavailable. |
| `onBatteryChanged?` | 1 | 1 | Same deprecated API. |
| `findInPage` | 1 | 1 | Ctrl+F, or the CSS Custom Highlight API (Chromium). |

#### Column C

| Member | Uses | Files | Endpoint / equivalent |
|---|---:|---:|---|
| `hud?` <br>_(17 members)_ | 21 | 12 | **C2** — Always-on-top overlay windows |
| `petOverlay` <br>_(9 members)_ | 18 | 2 | **C2** — Always-on-top overlay windows |
| `quickEntry` <br>_(10 members)_ | 8 | 3 | **C2** — Always-on-top overlay windows |
| `continueBootstrapLocal` | 7 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `windowRelay?` <br>_(2 members)_ | 6 | 4 | **C1** — Window chrome and multi-window IPC |
| `windowControls` <br>_(4 members)_ | 6 | 3 | **C1** — Window chrome and multi-window IPC |
| `revalidateConnection` | 5 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `touchBackend` | 4 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `wakeIndicator?` <br>_(3 members)_ | 4 | 3 | **C2** — Always-on-top overlay windows |
| `resetBootstrap` | 4 | 3 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `openWindow` | 3 | 2 | **C1** — Window chrome and multi-window IPC |
| `hudModifier?` | 3 | 3 | **C2** — Always-on-top overlay windows |
| `minimizeToTray?` <br>_(3 members)_ | 3 | 3 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `setPreviewGuestHidden?` | 3 | 2 | **C4** — DevTools / F12 and Electron input channels |
| `onWindowStateChanged?` | 3 | 3 | **C1** — Window chrome and multi-window IPC |
| `desktopMetrics?` <br>_(3 members)_ | 3 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `uninstall` <br>_(2 members)_ | 3 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getEmbedHostOrigin?` | 2 | 2 | **C1** — Window chrome and multi-window IPC |
| `openSessionWindow` <br>_(2 members)_ | 2 | 1 | **C1** — Window chrome and multi-window IPC |
| `openSessionInTerminal` <br>_(2 members)_ | 2 | 1 | **C1** — Window chrome and multi-window IPC |
| `openBrowserWindow` | 2 | 1 | **C1** — Window chrome and multi-window IPC |
| `chatOnboarding?` <br>_(2 members)_ | 2 | 1 | **C2** — Always-on-top overlay windows |
| `sshConfigHosts` | 2 | 2 | **C7** — Host resources the browser cannot reach |
| `sshResolveHost` | 2 | 1 | **C7** — Host resources the browser cannot reach |
| `setTranslucency?` | 2 | 2 | **C3** — Native window theming and glass |
| `setF12ShortcutActive?` | 2 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `renamePath?` | 2 | 1 | **C7** — Host resources the browser cannot reach |
| `trashPath?` | 2 | 1 | **C7** — Host resources the browser cannot reach |
| `repairBootstrap` | 2 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onBrowserPopoutClosed` | 1 | 1 | **C1** — Window chrome and multi-window IPC |
| `claimAmbientCue` | 1 | 1 | **C1** — Window chrome and multi-window IPC |
| `setSecretStorageEncryption` | 1 | 1 | **C7** — Host resources the browser cannot reach |
| `readWindowBelow?` <br>_(4 members)_ | 1 | 1 | **C7** — Host resources the browser cannot reach |
| `contextMenuSpellcheck?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `contextMenuGuestAddWord?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `onContextMenuSpellcheck?` <br>_(1 members)_ | 1 | 1 | **C5** — Preview `<webview>` internals |
| `capturePreview?` <br>_(3 members)_ | 1 | 1 | **C5** — Preview `<webview>` internals |
| `setTitleBarTheme?` | 1 | 1 | **C3** — Native window theming and glass |
| `setNativeTheme?` | 1 | 1 | **C3** — Native window theming and glass |
| `setDisableF12?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `onF12Shortcut?` <br>_(1 members)_ | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `setPreviewShortcutActive?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `onClosePreviewRequested?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `onOpenUpdatesRequested?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `onPoolBackendRetiring?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onConnectionApplied?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `cancelBootstrap` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `relaunchApp?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getRemoteDisplayReason?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onOpenFindBarRequested` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `getSecretStorageEncryption` | 0 | 0 | **C7** — Host resources the browser cannot reach |
| `agentPluginsRoot?` | 0 | 0 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getSyncStatus` | 0 | 0 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `stopFindInPage` | 0 | 0 | **C4** — DevTools / F12 and Electron input channels |
<!-- END GENERATED APPENDIX -->
