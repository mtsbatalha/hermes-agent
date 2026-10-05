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

1. **A registry home for `connections`.** Either a small server-side endpoint
   mirroring `connections.json`, or an explicit per-browser list with the
   limitation stated in Settings. The second is a product decision; the first is
   a few hours in `hermes_cli`.
2. **The ticket path, proven.** Phase 0 ran the loopback `?token=` form only. The
   gated `Sec-WebSocket-Protocol` ticket leg is the one a real deployment uses and
   it has never been exercised by the spike. It is the first thing Phase 2 should
   measure, because if it fails the same-origin design does not save it.

## Appendix — all 157 members

Every declared member, exactly one column. `Uses` and `Files` are measured over
`src/**`; `(n members)` is the namespace's nested member count, included in the
157 by contract but not counted again in the row's use total.
#### Column A

| Member | Uses | Files | Endpoint / equivalent |
|---|---:|---:|---|
| `api` | 101 | 39 | The REST funnel. One function to reimplement; 101 measured call sites behind it. |
| `getConnection` <br>_(2 members)_ | 99 | 20 | Gateway socket handle. Boot-critical — the spike proved the renderer never submits without it. |
| `profile` <br>_(6 members)_ | 56 | 24 | /api/profiles/active + ?profile=; `set` becomes client state + profile selector. |
| `getConnectionFor?` <br>_(3 members)_ | 52 | 14 | Same socket, registry-scoped. |
| `readFileDataUrl` | 38 | 14 | /api/fs/read-data-url |
| `getGatewayWsUrl` | 26 | 3 | Mints the socket URL. Boot-critical. |
| `connections` <br>_(10 members)_ | 22 | 19 | — |
| `getGatewayWsUrlFor?` <br>_(2 members)_ | 21 | 7 | Registry-scoped mint. Boot-critical; the renderer branches on its presence. |
| `cloud` <br>_(5 members)_ | 19 | 6 | Portal login round-trip; discovery is a REST call. |
| `applyConnectionConfig` | 14 | 6 | Re-dial against the new descriptor. |
| `probeConnectionConfig` | 14 | 6 | Server-side reachability probe. |
| `saveGatewayFile?` <br>_(8 members)_ | 13 | 6 | /api/files/download — the HOST writes; the browser never needs a path picker. |
| `readDir` | 12 | 3 | /api/fs/list |
| `testConnectionConfig` | 11 | 5 | Reachability probe against the saved descriptor. |
| `updates` <br>_(8 members)_ | 11 | 4 | /api/hermes/update/check + /api/hermes/update. Branch/packaging members are Desktop-only and get no UI. |
| `getAgentRoster?` | 10 | 7 | Union roster over registered connections → /api/profiles. |
| `oauthLoginConnectionConfig` <br>_(2 members)_ | 10 | 6 | URL round-trip; callback lands same-origin. |
| `getConnectionConfig` | 7 | 5 | The descriptor is built client-side from the endpoint URL the user typed. |
| `oauthLogoutConnectionConfig` | 7 | 5 | /api/providers/oauth |
| `sanitizeWorkspaceCwd` | 7 | 4 | Server-side sanitiser already exists. |
| `settings` <br>_(3 members)_ | 7 | 4 | /api/fs/default-cwd (get/set). |
| `revealLogs` | 7 | 7 | /api/env/reveal |
| `git?` <br>_(10 members)_ | 7 | 6 | Full 1:1 REST surface at /api/git/* — worktrees, branches, status, file-diff and the entire review pane (stage/unstage/revert/commit/push/create-pr/pr-list/ship-info/commit-context). |
| `zoom?` <br>_(4 members)_ | 6 | 4 | Client-side; the browser owns zoom. |
| `gitRoot?` | 6 | 3 | /api/fs/git-root |
| `getProfileRoutes` | 4 | 2 | Credential-free routes → /api/profiles/active. |
| `saveConnectionConfig` | 4 | 3 | Client-side persistence of the endpoint entry. |
| `dataUrlReadMax?` <br>_(2 members)_ | 4 | 2 | Server cap + a client pref. |
| `normalizePreviewTarget` | 4 | 3 | Pure URL logic — runs in the browser as-is. |
| `stopPreviewFileWatch` | 4 | 2 | Client-side handle teardown. |
| `logLine?` | 4 | 3 | Console + /api/ops/debug-share. |
| `revealPath?` | 4 | 3 | /api/env/reveal |
| `themes` <br>_(2 members)_ | 4 | 3 | /api/dashboard/themes + /api/dashboard/theme |
| `readPluginSource?` | 3 | 2 | /api/dashboard/agent-plugins/{name} |
| `openDir?` | 3 | 3 | /api/env/reveal |
| `desktopPluginsRoot?` | 3 | 3 | /api/dashboard/plugins |
| `reconcileDesktopPlugins?` | 3 | 3 | /api/dashboard/plugins/rescan |
| `terminal` <br>_(8 members)_ | 3 | 2 | /api/pty over WebSocket, plus /api/tools/terminal/backend for the probe. |
| `probePluginRepo?` <br>_(8 members)_ | 3 | 2 | /api/dashboard/plugins/catalog |
| `installDesktopPlugin?` <br>_(3 members)_ | 3 | 2 | /api/dashboard/agent-plugins/install |
| `onPreviewFileChanged` | 3 | 2 | Same poll/events seam as watchPreviewFile. |
| `readFileText` | 2 | 1 | /api/fs/read-text |
| `watchPreviewFile` | 2 | 2 | No OS watcher in a browser: poll /api/files/read or ride /api/events. |
| `watchDirectory?` | 2 | 1 | Same poll/events seam as watchPreviewFile. |
| `onExternalOpenFailed?` | 2 | 1 | Client-side error state; the browser reports a blocked pop-up itself. |
| `mcpOauth?` <br>_(3 members)_ | 2 | 2 | /api/mcp/oauth/flows/{flow_id} + /api/mcp/oauth/callback/{server_name}. |
| `reportRendererError?` <br>_(4 members)_ | 2 | 2 | POST to /api/ops/doctor. |
| `logsRoot?` | 2 | 1 | /api/env/reveal |
| `writeTextFile?` | 2 | 1 | /api/fs/write-text |
| `reachPreviewUrl?` | 2 | 2 | URL resolution — client-side. |
| `removeDesktopPlugin?` | 2 | 2 | /api/dashboard/agent-plugins/{name} |
| `probeLocalBackend?` | 2 | 2 | /api/health answers "is a gateway already up" — the whole reason this member exists. |
| `recycleBackend?` | 2 | 2 | /api/gateway/restart |
| `getVersion` | 2 | 2 | /api/status |
| `getMachineProfile?` | 2 | 2 | /api/host/identity |
| `claimStartupLatency?` | 1 | 1 | Client-measurable (performance.now) — no host fact needed. |
| `readFileDataUrlForAttach?` | 1 | 1 | /api/fs/read-data-url (server-side cap differs). |
| `localModelsEnabled?` | 1 | 1 | /api/local-models/status — the flag is the backend answering. |
| `guestOnboardingEnabled?` | 1 | 1 | A launch flag the web client no longer sets: it is read from the gateway it attached to. |
| `localSkin?` | 1 | 1 | Sanitized config the browser can read from /api/config. |
| `setActiveConnectionRoute?` <br>_(1 members)_ | 1 | 1 | Client-side route state. |
| `onOpenFolderRequested?` | 1 | 1 | Becomes a route + /api/env/reveal. |

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
| `saveImageFromUrl` | 4 | 2 | anchor + download, or /api/media/proxy then download. |
| `getPathForFile` | 4 | 2 | File / FileReader, Blob URLs — drag-and-drop attach works natively. |
| `onFoundInPage` | 3 | 2 | Custom Highlight API counters (Chromium). |
| `readClipboard` | 2 | 2 | navigator.clipboard.read — needs transient activation. |
| `contextMenuCopyImage?` | 2 | 2 | Canvas → data URL → clipboard. |
| `savePastedText` | 2 | 2 | anchor + download. |
| `setActiveWork?` | 2 | 2 | Web App Badges (Chromium-only) / document.title fallback. |
| `setKeepAwake?` | 2 | 2 | Screen Wake Lock — active tab only, released when backgrounded. |
| `onDeepLink?` <br>_(1 members)_ | 2 | 2 | URL query/hash — a bookmarkable link, not an OS protocol handler. |
| `onPowerResume?` | 2 | 2 | visibilitychange — an approximation, not a real power event. |
| `requestMicrophoneAccess` | 1 | 1 | getUserMedia — needs HTTPS + a permission prompt. |
| `contextMenuEdit?` | 1 | 1 | Clipboard API against the focused element. |
| `saveClipboardImage` | 1 | 1 | navigator.clipboard.read image + download. |
| `fetchLinkTitle` | 1 | 1 | fetch + oEmbed — CORS-bound; degrades to the bare URL. |
| `resolveFavicon?` | 1 | 1 | fetch + /api/media/proxy fallback. |
| `onPreviewNav?` | 1 | 1 | iframe + postMessage — cross-origin frames cannot be driven. |
| `signalDeepLinkReady?` | 1 | 1 | Client-side handshake once the deep link is parsed. |
| `onFocusSession?` | 1 | 1 | visibilitychange + focus events. |
| `onNotificationAction?` | 1 | 1 | Notification.onclick — works, but only while the tab lives. |
| `onNotificationActivate?` <br>_(1 members)_ | 1 | 1 | Notification.onclick. |
| `getOnBattery?` | 1 | 1 | Battery Status API — DEPRECATED and Chromium-only. Ship as unavailable. |
| `onBatteryChanged?` | 1 | 1 | Same deprecated API. |
| `findInPage` | 1 | 1 | Ctrl+F, or CSS Custom Highlight API (Chromium). |

#### Column C

| Member | Uses | Files | Endpoint / equivalent |
|---|---:|---:|---|
| `hud?` <br>_(17 members)_ | 21 | 12 | **C2** — Always-on-top overlay windows |
| `petOverlay` <br>_(9 members)_ | 18 | 2 | **C2** — Always-on-top overlay windows |
| `getBootProgress` | 11 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `quickEntry` <br>_(10 members)_ | 8 | 3 | **C2** — Always-on-top overlay windows |
| `continueBootstrapLocal` | 7 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `windowRelay?` <br>_(2 members)_ | 6 | 4 | **C1** — Window chrome and multi-window IPC |
| `windowControls` <br>_(4 members)_ | 6 | 3 | **C1** — Window chrome and multi-window IPC |
| `revalidateConnection` | 5 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `touchBackend` | 4 | 2 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `wakeIndicator?` <br>_(3 members)_ | 4 | 3 | **C2** — Always-on-top overlay windows |
| `glassSupported?` | 4 | 2 | **C3** — Native window theming, glass and host flags |
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
| `translucencySupported?` | 2 | 1 | **C3** — Native window theming, glass and host flags |
| `setTranslucency?` | 2 | 2 | **C3** — Native window theming, glass and host flags |
| `setF12ShortcutActive?` | 2 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `renamePath?` | 2 | 1 | **C7** — Host resources the browser cannot reach |
| `trashPath?` | 2 | 1 | **C7** — Host resources the browser cannot reach |
| `repairBootstrap` | 2 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onBootstrapEvent` | 2 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getPoolLimits` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `setPoolLimits` <br>_(2 members)_ | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onBrowserPopoutClosed` | 1 | 1 | **C1** — Window chrome and multi-window IPC |
| `claimAmbientCue` | 1 | 1 | **C1** — Window chrome and multi-window IPC |
| `setSecretStorageEncryption` | 1 | 1 | **C7** — Host resources the browser cannot reach |
| `readWindowBelow?` <br>_(4 members)_ | 1 | 1 | **C7** — Host resources the browser cannot reach |
| `contextMenuSpellcheck?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `contextMenuGuestAddWord?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `onContextMenuSpellcheck?` <br>_(1 members)_ | 1 | 1 | **C5** — Preview `<webview>` internals |
| `capturePreview?` <br>_(3 members)_ | 1 | 1 | **C5** — Preview `<webview>` internals |
| `setTitleBarTheme?` | 1 | 1 | **C3** — Native window theming, glass and host flags |
| `setNativeTheme?` | 1 | 1 | **C3** — Native window theming, glass and host flags |
| `setDisableF12?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `onF12Shortcut?` <br>_(1 members)_ | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `setPreviewShortcutActive?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `getRecentLogs` | 1 | 1 | **C7** — Host resources the browser cannot reach |
| `onClosePreviewRequested?` | 1 | 1 | **C5** — Preview `<webview>` internals |
| `onOpenUpdatesRequested?` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `onBackendExit` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onPoolBackendRetiring?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onConnectionApplied?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onBootProgress` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `cancelBootstrap` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `relaunchApp?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getRemoteDisplayReason?` | 1 | 1 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `onOpenFindBarRequested` | 1 | 1 | **C4** — DevTools / F12 and Electron input channels |
| `getSecretStorageEncryption` | 0 | 0 | **C7** — Host resources the browser cannot reach |
| `agentPluginsRoot?` | 0 | 0 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getBootstrapState` | 0 | 0 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `getSyncStatus` | 0 | 0 | **C6** — Host process lifecycle, bootstrap and Desktop packaging |
| `stopFindInPage` | 0 | 0 | **C4** — DevTools / F12 and Electron input channels |