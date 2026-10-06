/**
 * The Fase 1 capability classification — DATA ONLY, no logic.
 *
 * `audit-contract.mjs` reads this, cross-checks it against the contract in
 * `src/global.d.ts` and the implementation in `electron/preload.ts`, and fails
 * the run when the two drift apart. Adding a member to the bridge without
 * adding it here is a build failure, on purpose.
 *
 * Column semantics (see ../CAPABILITY-MATRIX.md):
 *   A — already web-native: the backend owns the capability and the browser
 *       speaks it unchanged (a REST route or a gateway method).
 *   B — a browser API exists, and the caveat has to be designed for.
 *   C — no browser equivalent; cut in v1. Every C member MUST name a family in
 *       FAMILIES, and every family MUST carry the copy the UI shows instead.
 *
 * Keys are top-level members of the `hermesDesktop` declaration. A `ns.leaf` key
 * overrides a single member of a namespace that otherwise sits in one column.
 */

export const A = {
  getConnection: 'Gateway socket handle. Boot-critical — without it the renderer never submits.',
  getConnectionFor: 'Same socket, registry-scoped.',
  getGatewayWsUrl: 'Mints the socket URL. Boot-critical.',
  getGatewayWsUrlFor: 'Registry-scoped mint. Boot-critical; the renderer branches on its presence.',
  getAgentRoster: 'Union roster over registered connections → /api/profiles.',
  getProfileRoutes: 'Credential-free routes → /api/profiles/active.',
  getConnectionConfig: 'The descriptor is built client-side from the endpoint URL the user typed.',
  saveConnectionConfig: 'Client-side persistence of the endpoint entry.',
  applyConnectionConfig: 'Re-dial against the new descriptor.',
  testConnectionConfig: 'Reachability probe against the saved descriptor.',
  api: 'The REST funnel. One function to reimplement; 101 measured call sites behind it.',
  claimStartupLatency: 'Client-measurable (performance.now) — no host fact needed.',
  readFileDataUrl: 'GET /api/fs/read-data-url — measured 200 with a real data URL.',
  readFileDataUrlForAttach: 'GET /api/fs/read-data-url (the server enforces the lower cap).',
  dataUrlReadMax: 'Server cap + a client pref.',
  readFileText: 'GET /api/fs/read-text — measured 200 with byteSize/language/mimeType.',
  readPluginSource: 'GET /api/config/raw and /api/dashboard/agent-plugins/{name}.',
  saveGatewayFile: 'GET /api/files/download — the HOST writes; the browser needs no path picker.',
  probeConnectionConfig: 'Server-side reachability probe.',
  oauthLoginConnectionConfig: 'URL round-trip; the callback lands same-origin.',
  oauthLogoutConnectionConfig: 'GET /api/providers/oauth',
  cloud: 'Portal login round-trip; discovery is a REST call.',
  profile: '/api/profiles/active + ?profile=; `set` becomes client state plus the profile selector.',
  onExternalOpenFailed: 'Client-side error state; the browser reports a blocked pop-up itself.',

  // Reclassified out of C in Phase 2. Each is a NON-OPTIONAL contract member the
  // renderer calls UNGUARDED at module load, so cutting it threw during import
  // and the app never finished booting — that is what the first real-bridge run
  // exposed. They are also genuinely answerable, so "cut" was never the honest
  // description: each names what actually backs it here.
  glassSupported:
    'Reports a constant `false`: the browser frame is not a native window. A real fact the renderer branches on, not a stub.',
  translucencySupported: 'Reports a constant `false`: there is no native chrome to make translucent.',
  onBackendExit: 'Real subscription fed by the gateway socket close — the only exit signal a browser client gets.',
  getPoolLimits: 'Client-side constant: this client owns no backend pool, so it reports one gateway.',
  setPoolLimits: 'Rejected with `ok:false` and the current limits: the pool belongs to the host running the gateway.',
  getBootProgress:
    'Reports `running:false, progress:1` — a browser client attaches to a gateway somebody else installed, so it is ready the moment the socket opens.',
  onBootProgress: 'Live subscription with no host source: nothing to install means nothing to report.',
  getBootstrapState:
    'Reports `active:false`: bootstrap is inapplicable to a client that attaches to a running gateway.',
  onBootstrapEvent: 'Live subscription with no host source, for the same reason as getBootstrapState.',
  // Scoped honestly: NOT the host's log files (those stay C7 — /api/ssh/ownership
  // measured 404 "SSH ownership is not active"). This is the renderer-visible
  // trace ring buffer, and `path` reports "in-page" so the source can never be
  // mistaken for a file on disk.
  getRecentLogs:
    'In-page trace ring buffer fed by logLine. `path` reports "in-page" so it is never mistaken for the host log files.',
  mcpOauth: '/api/mcp/oauth/flows/{flow_id} + /api/mcp/oauth/callback/{server_name}.',
  sanitizeWorkspaceCwd: 'Server-side sanitiser already exists.',
  settings: '/api/fs/default-cwd (get/set).',
  zoom: 'Client-side; the browser owns zoom.',
  reportRendererError: 'POST /api/ops/doctor — measured 200.',
  logLine: 'POST /api/ops/doctor / /api/ops/debug-share.',
  readDir: 'GET /api/fs/list — measured 200 with real entries.',
  gitRoot: 'GET /api/fs/git-root — measured 200 with the repo root.',

  desktopPluginsRoot: 'GET /api/dashboard/plugins',
  reconcileDesktopPlugins: 'GET /api/dashboard/plugins/rescan — measured 200 {ok,count}.',

  writeTextFile: 'POST /api/fs/write-text',
  git: 'GET /api/git/* — measured 200 for status, branches, base-branches, worktrees, file-diff and review/list + review/diff. The full review pane (stage/unstage/revert/commit/push/create-pr/pr-list/ship-info/commit-context) is declared 1:1 in hermes_cli/web_routers/git.py.',
  terminal:
    '/api/pty over WebSocket, measured live: raw PTY bytes both ways (not a JSON envelope) and an in-band \x1b[RESIZE:cols;rows] escape the server consumes when it is the whole frame. The child is `hermes --tui`, not a shell. 15262 bytes of real TUI screen on a cold dial. GET /api/tools/terminal/backends answers the probe (measured 200).',
  reachPreviewUrl: 'URL resolution — client-side.',
  setActiveConnectionRoute: 'Client-side route state.',
  onOpenFolderRequested: 'Becomes a route plus /api/env/reveal.',
  probePluginRepo: 'GET /api/dashboard/plugins/catalog',
  installDesktopPlugin: 'POST /api/dashboard/agent-plugins/install',
  removeDesktopPlugin: 'DELETE /api/dashboard/agent-plugins/{name}',
  onPreviewFileChanged: 'Same poll/events seam as watchPreviewFile.',
  probeLocalBackend: 'GET /api/health answers "is a gateway already up" — measured 200.',
  recycleBackend: 'POST /api/gateway/restart',
  getVersion: 'GET /api/status — measured 200.',
  getMachineProfile: 'GET /api/host/identity — measured 200.',
  updates: 'GET /api/hermes/update/check — measured 200. Branch/packaging members are Desktop-only and get no UI.',
  themes: 'GET /api/dashboard/themes + /api/dashboard/font — both measured 200.',
  connections:
    'NO SERVER HOME. See the connections section of the matrix: the registry is Electron userData (connections.json), unreadable by any browser and served by no route. /api/profiles and /api/chat/workspaces cover neighbours, not the registry.',
  localModelsEnabled: 'GET /api/local-models/status — measured 200.',
  guestOnboardingEnabled: 'A launch flag the web client no longer sets: read it from the gateway it attached to.',
  localSkin: 'Sanitized config the browser reads from /api/config.',
  watchPreviewFile: 'No OS watcher in a browser: poll /api/fs/read-text or ride /api/events.',
  watchDirectory: 'Same poll/events seam as watchPreviewFile.',
  stopPreviewFileWatch: 'Client-side handle teardown.',
  normalizePreviewTarget: 'Pure URL logic — runs in the browser as-is.'
}

export const B = {
  screenshot: 'getDisplayMedia — the user must pick a surface; no silent capture.',
  notify: 'Notification API — denied by default on Android; push is the only durable answer.',
  requestMicrophoneAccess: 'getUserMedia — needs HTTPS and a permission prompt.',
  selectPaths: 'showOpenFilePicker (Chromium) / <input type=file> elsewhere.',
  selectSavePath: 'showSaveFilePicker (Chromium) / anchor download elsewhere.',
  writeClipboard: 'navigator.clipboard.write — needs transient activation.',
  readClipboard: 'navigator.clipboard.read — needs transient activation.',
  saveImageFromUrl:
    'anchor + download. /api/media/proxy measured 403 for a non-allowlisted host, so the allowlist is part of the design.',
  saveImageBuffer: 'anchor + download. A real download, no silent path.',
  savePastedText: 'anchor + download.',
  saveClipboardImage: 'navigator.clipboard.read image + download.',
  getPathForFile: 'File / FileReader, Blob URLs — drag-and-drop attach works natively.',
  contextMenuEdit: 'Clipboard API against the focused element.',
  contextMenuCopyImage: 'Canvas → data URL → clipboard.',
  openExternal: 'anchor / window.open behind the click gate (see the guest-content rule).',
  openPreviewInBrowser: 'window.open with noopener behind a user click.',
  fetchLinkTitle: 'fetch + oEmbed — CORS-bound; degrades to the bare URL.',
  resolveFavicon: 'GET /api/media/proxy behind an allowlist — measured 403 off-allowlist, not an open proxy.',
  onDeepLink: 'URL query/hash — a bookmarkable link, not an OS protocol handler.',
  signalDeepLinkReady: 'Client-side handshake once the deep link is parsed.',
  setActiveWork: 'Web App Badges (Chromium-only) / document.title fallback.',
  setKeepAwake: 'Screen Wake Lock — active tab only, released when backgrounded.',
  onPowerResume: 'visibilitychange — an approximation, not a real power event.',
  getOnBattery: 'Battery Status API — DEPRECATED and Chromium-only. Ship as unavailable.',
  onBatteryChanged: 'Same deprecated API.',
  onFocusSession: 'visibilitychange + focus events.',
  onNotificationAction: 'Notification.onclick — works, but only while the tab lives.',
  onNotificationActivate: 'Notification.onclick.',
  findInPage: 'Ctrl+F, or the CSS Custom Highlight API (Chromium).',
  onFoundInPage: 'Custom Highlight API counters (Chromium).',
  onPreviewNav: 'iframe + postMessage — a cross-origin frame cannot be driven.',
  'settings.pickDefaultProjectDir': 'Directory picker — see the settings namespace.'
}

/** member -> family id. Every C member needs one. */
export const C = {
  getEmbedHostOrigin: 'C1',
  openSessionWindow: 'C1',
  openSessionInTerminal: 'C1',
  openWindow: 'C1',
  openBrowserWindow: 'C1',
  windowRelay: 'C1',
  onBrowserPopoutClosed: 'C1',
  claimAmbientCue: 'C1',
  windowControls: 'C1',
  onWindowStateChanged: 'C1',

  petOverlay: 'C2',
  hud: 'C2',
  hudModifier: 'C2',
  wakeIndicator: 'C2',
  quickEntry: 'C2',
  chatOnboarding: 'C2',

  setTitleBarTheme: 'C3',
  setNativeTheme: 'C3',
  setTranslucency: 'C3',

  // CORRECTED in Phase 3. These four were classified A with the endpoint
  // `/api/env/reveal`, which is wrong in a way that matters: that route reveals
  // the UNREDACTED value of ONE ENVIRONMENT VARIABLE, rate-limited to 5 per 30s
  // and audit-logged (web_routers/config_env.py). Wiring `revealLogs` to it
  // would POST a secret-unmasking request instead of opening a folder.
  //
  // The real Electron implementations are `shell.showItemInFolder` /
  // `shell.openPath` — OS file-manager actions on the host. Measured: there is
  // NO server route for either. On a remote gateway "reveal in Explorer" opens
  // Explorer on a screen nobody is looking at, so C with honest copy is the
  // truthful column, not a convenient one.
  revealLogs: 'C8',
  revealPath: 'C8',
  openDir: 'C8',
  logsRoot: 'C8',

  setDisableF12: 'C4',
  setF12ShortcutActive: 'C4',
  onF12Shortcut: 'C4',
  setPreviewShortcutActive: 'C4',
  setPreviewGuestHidden: 'C4',
  onOpenUpdatesRequested: 'C4',
  stopFindInPage: 'C4',
  onOpenFindBarRequested: 'C4',

  capturePreview: 'C5',
  contextMenuSpellcheck: 'C5',
  contextMenuGuestAddWord: 'C5',
  onContextMenuSpellcheck: 'C5',
  onClosePreviewRequested: 'C5',

  minimizeToTray: 'C6',
  relaunchApp: 'C6',
  uninstall: 'C6',
  onPoolBackendRetiring: 'C6',
  onConnectionApplied: 'C6',
  revalidateConnection: 'C6',
  touchBackend: 'C6',

  continueBootstrapLocal: 'C6',
  resetBootstrap: 'C6',
  repairBootstrap: 'C6',
  cancelBootstrap: 'C6',
  getSyncStatus: 'C6',
  agentPluginsRoot: 'C6',
  desktopMetrics: 'C6',
  getRemoteDisplayReason: 'C6',

  readWindowBelow: 'C7',
  sshConfigHosts: 'C7',
  sshResolveHost: 'C7',
  renamePath: 'C7',
  trashPath: 'C7',
  getSecretStorageEncryption: 'C7',
  setSecretStorageEncryption: 'C7'
}

/**
 * Each family carries the copy the UI shows instead of the cut member — the
 * repo rule from AGENTS.md: "empty, loading, reconnecting, degraded/stale, and
 * exhausted-recovery each deserve their own honest copy and their own way out."
 */
export const FAMILIES = {
  C1: {
    title: 'Window chrome and multi-window IPC',
    copy: 'No custom titlebar: the browser frame is the frame. Every "open in a new window" action becomes "open in a new tab" (a link), and the pop-out Browser button is replaced by that link. Cross-window coordination disappears — there is only one window.'
  },
  C2: {
    title: 'Always-on-top overlay windows',
    copy: 'HUD, pet, wake indicator and Quick Entry are separate OS windows. They are removed, not half-rendered. Quick Entry survives only as a documented in-page shortcut; the chord itself is listed as unavailable.'
  },
  C3: {
    title: 'Native window theming and glass',
    copy: 'The web theme governs the whole surface. The two fact members report a constant so the renderer takes its own "unsupported" branch instead of guessing.'
  },
  C4: {
    title: 'DevTools / F12 and Electron input channels',
    copy: 'The browser owns F12 and its own find bar. The FindBar is removed and Ctrl+F documented; Desktop-only toggles are hidden rather than shown disabled-but-clickable.'
  },
  C5: {
    title: 'Preview `<webview>` internals',
    copy: 'Previews become sandboxed iframes. The two with no equivalent at all report an explicit "Not available in the browser client"; the app never returns an empty image or a silent no-op.'
  },
  C6: {
    title: 'Host process lifecycle, bootstrap and Desktop packaging',
    copy: 'A browser client attaches to a gateway somebody else runs, so nothing here is faked: no tray, no relaunch, no uninstall, no install/bootstrap flow. The bootstrap onboarding screen is replaced by one honest "Connect to a Hermes gateway" form, Settings reads "Managed on the host" where a Desktop-only action used to sit, and the status bar reads "Gateway offline — retrying" with its countdown, because the socket close is the only signal a browser gets.'
  },
  C7: {
    title: 'Host resources the browser cannot reach',
    copy: 'SSH config, the OS trash, the OS keychain, cross-window metadata and host log lines have no browser counterpart. /api/ssh/ownership exists but answers "SSH ownership is not active", so the SSH pair is cut on measurement, not on principle. Each surfaces an explicit "Not available in the web client" line rather than an empty list that reads as a bug.'
  },
  C8: {
    title: 'The host OS file manager',
    copy: 'Revealing a path or opening a folder is an action on the machine that runs the gateway, and there is no server route for it — /api/env/reveal is a different thing entirely: it unmasks one environment variable, rate-limited and audit-logged. On a remote gateway the button would open Explorer on a screen nobody is looking at, so it is removed rather than quietly wired to the wrong endpoint. The path itself still shows, so it can be copied and opened wherever the file actually lives.'
  }
}
