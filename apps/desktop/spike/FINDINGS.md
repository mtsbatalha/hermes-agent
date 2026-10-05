# Fase 0 — Spike verdict

Question the spike had to answer: **does the Desktop conversation hold up outside
Electron?**

**Verdict: the premise holds, and streaming is proven.** The renderer runs in a
plain browser tab, paints the real Desktop UI, speaks to a live `hermes serve`
gateway over the real JSON-RPC/WebSocket protocol, streams a reply token by
token, and drives a tool end to end — all outside Electron, at both desktop and
phone widths, in dev and in a production build.

Run it with the steps in [README.md](./README.md).

## What was proven, with evidence

| Claim | Evidence |
|---|---|
| The renderer is browser code, not Electron-bound | The unmodified `/src/main.tsx` booted in Chromium and painted the real shell: `SESSIONS / BOTS / Capabilities / Messaging / Artifacts / Scheduled jobs`, the `NEW SESSION` composer, the status bar |
| REST to the gateway works from a browser | `/api/status`, `/api/model/info`, `/api/config`, `/api/profiles`, `/api/sessions` all answered 200; the real model `DeepSeek V4 · Flash` loaded into the UI |
| The WS handshake succeeds and the gateway speaks | `101 Switching Protocols`; the gateway emits `{"method":"event","params":{"type":"gateway.ready",...}}`; the renderer actively issues RPCs (`client.capabilities`, id=2, logged server-side) |
| The layout is already responsive | At 390×844 the sidebar disappears and the chat fills the viewport — no separate mobile design is needed for the shell itself |
| Screenshots | [wide](artifacts/spike-1280x900.png), [narrow](artifacts/spike-narrow.png) |

## Measured surface

- **128 distinct bridge members**, referenced across **1,191 call sites in 353 files** (`window.hermesDesktop.*` under `apps/desktop/src`).
- The harness stub implements **34** top-level members. To get from module load to a painted shell it still needed **47 more**, of which **23 are `on<Event>(callback) → unsubscribe`** pairs — `onPowerResume`, `onWindowStateChanged`, `onPreviewFileChanged`, `onBatteryChanged`, and so on. Each returns a *function*, not a promise. The bridge type declares **38** `on*` members in total, so most of that family is on the boot path.
- **234 distinct member paths** were touched that the harness did not implement. The full list is what `probe.mjs` prints under `CAPACIDADES AUSENTES`; `__spike.accessed()` in the browser console gives the same data interactively.

## The load-bearing finding: the credential rides in the URL

The gateway's WebSocket handshake reads the credential from the **query string**
— `?token=` in loopback mode, `?ticket=` in gated mode — and does **not** accept
the `X-Hermes-Session-Token` header that the REST layer uses
(`hermes_cli/web_server.py:377`, `hermes_cli/web_server_chat.py:250`).

The plan's same-origin + `HttpOnly` cookie design is therefore not a
nice-to-have; it is the only thing standing between this client and a session
token sitting in browser history and proxy access logs. The upstream code is
already careful about the sibling risk — `_resolve_session_token` dies with the
process and is injected into the SPA HTML rather than exposed — but that is a
mitigation for the bundled UI, not an API a standalone web client can use.

## The blocker, and what it actually turned out to be

The first pass reported "the renderer closes its own gateway socket ~500 ms
after connecting" and put it down to the `gateway.ready` handshake. **That was
wrong**, and chasing it is what produced the real answer.

Frame-level tracing showed the primary socket is **healthy**: `open`, 11
requests, 11 responses, `gateway.ready`, `session.active_list` returning
`{"sessions": []}`, and a `gateway.ping` round-tripping `{"ok": true}`. It never
closes. The `messages=2` in the server log belongs to a *second* socket. The
`socket teardown` was a misread.

The actual chain, captured from the renderer's own diagnostics via the bridge's
`logLine` member:

```
[gateway-route win=main] conn:undefined::default via=secondary primary=undefined/default
[gateway-route win=main] published connection=undefined
```

1. The harness bridge leaves the connection-descriptor members unimplemented, so
   they hand back a placeholder instead of a connection object.
2. The renderer builds a composite scope `` `${connectionId}::${profile}` ``,
   and the placeholder stringifies to the literal `"undefined"` — so the scope
   becomes `undefined::default` and `g.primaryProfile` is `"undefined"`.
3. `reportGatewayState` only publishes when `normKey(profile) === g.activeKey`.
   That never matches, so `$gatewayState` stays `'closed'` while a healthy
   socket is open on the wire.
4. The composer computes `reconnecting = gatewayState !== 'open'`
   (`use-composer-placeholder.ts`), disables submit, and `prompt.submit` is
   **never sent** — which is what all the "socket closed" evidence was a
   downstream symptom of.

**Diagnosis: a defect in the harness bridge, not in the port.** The renderer
never tried to send anything, so nothing here says a browser client cannot
stream — and it turned out not to.

The fix was two members, both named by the trace: `getConnection` /
`getConnectionFor` (return a real `HermesConnection` with `profile: 'default'`)
and `profile.get` (return `{ profile: null }`). The boot path reads its active
profile from `override ?? (await desktop.profile?.get?.())?.profile ?? ''`
(`use-gateway-boot.ts`), and placeholders in either position made that the
string `"undefined"`. With both implemented the trace becomes correct —
`active key=default via=primary conn=- profile=default` — the churn disappears
(one socket, no secondary spawn-and-close loop), and streaming works.

## Acceptance criterion: met

`stream.mjs` drives the real composer and asserts on the protocol. Green in all
three configurations:

| Run | Viewport | Sockets | `message.start` / `delta` / `complete` | Tool frames |
|---|---|---|---|---|
| dev, 1280×900 | wide | 1 | 1 / 1 / 1 | 0 |
| dev, 390×844 | narrow | 1 | 1 / 1 / 1 | 0 |
| production build, 1280×900 | wide | 1 | 1 / 1 / 1 | 0 |
| production build, tool-forcing prompt | wide | 1 | 1 / **3** / 1 | **3** |

A real reply came back as `"payload": {"text": "streamed-ok"}`. With a prompt
that forces a tool, the full lifecycle is observable on the wire:

```
tool.generating  {"name": "terminal"}
tool.start       {"name": "terminal", "args": {"command": "echo toolcard-ok"}}
tool.complete    {"name": "terminal", "duration_s": 2.x}
```

That is the data the Desktop tool card renders, arriving from a plain browser
tab against a real gateway. **A browser client can stream and can drive tools.**

Session switching is verified by the gate in both directions at both widths.

Two hypotheses were tested and refuted before this one, and both are recorded
because they are the obvious next guesses:

- `getPoolLimits` returning `{maxBackends: 1, idleMs: 0}` retiring idle pool
  backends instantly — churning a profile-scoped secondary. Real churn, but not
  the cause; changing it to the real defaults changed nothing observable.
- `import.meta.hot` under `vite dev` triggering the boot effect's destructive
  teardown (`setPrimaryGateway(null)`). Plausible from the code, and wrong: the
  production build reproduces the same state.

## Fase 0 verdict: GO

**GO.** The question the spike was commissioned to answer is answered in the
affirmative: the Desktop conversation holds up outside Electron.

Proven, through the real UI against a live gateway, in Chromium:

- The renderer boots and paints the real shell, in dev and in a production build.
- A message submitted through the real composer **streams back** over the
  protocol (`message.start` → `message.delta` → `message.complete`), with the
  model's actual reply text arriving on the wire.
- A **tool runs end to end** and the events the Desktop tool card renders
  (`tool.generating` / `tool.start` / `tool.complete`) reach the client.
- **Session switching works with no cross-contamination**, at 1280×900 and at
  390×844, in both directions: while B is active, A's text appears only as a
  sidebar row and never in B's transcript, and vice versa.
- The layout is already responsive — at 390px the sidebar collapses behind a
  "Show sidebar" control and the chat fills the viewport.

**Resolved:** the "Ctrl+N at 390px doesn't dispatch" defect reported earlier was
**misattributed**. It is neither a renderer bug nor a stub defect. The trace and
the wire frames show the turn WAS submitted — `session.create` and
`prompt.submit` both appear — and the transcript carries the provider's own
notice:

```
⏳ rate limited — resets in ~60s, retrying in 60s (attempt 1/3)
```

The upstream model provider rate-limited, so the gateway held the turn and
retried on a ~60s cycle. The harness's 120s budget expired mid-retry and
reported a stall that was never a client fault. `Ctrl+N` itself is clean: the
`logLine` trace after the shortcut is **empty** — it does not disturb gateway
activation at all, which refutes the original hypothesis directly.

The fix is in the harness only: the turn deadline now covers the backend's
documented retry cycle (300s), and a turn that times out while the transcript
shows a rate-limit notice is reported with that attribution instead of as a
mystery stall. With it, `stream.mjs --width 390` passes on consecutive runs.

Not proven, and deliberately not claimed:

- **Explicit session switching was verified; broader session lifecycle was not.**
  No run covered deleting, renaming or archiving a session.
- Only one gateway configuration was exercised (single profile, local mode).
- No multi-profile run, so the profile-scoped secondary pool — the code path
  that churned before the fix — remains untested under real multi-profile load.
- The 404 in the console was never identified. It is present on every run and
  has not been shown to be harmless.

## Why this was invisible for so long

`traceIdentityChange` in `lib/identity-trace.ts` routes the app's own identity
diagnostics through `window.hermesDesktop.logLine`. The harness never
implemented `logLine`, so every trace the renderer emitted — including the two
lines above, which name the defect — was discarded. Implementing that one member
turned an hour of guessing into the answer in one run. It is the single most
valuable thing this spike produced for the next phase: **a browser bridge that
does not implement `logLine` is blind.**

## Status of the acceptance criterion

Met — see the table above. `stream.mjs` exits 0 in every configuration it was
run against, including the production build.

## Two things that were wrong in the harness, worth recording

Neither is a finding about the port, but both cost real time and would mislead
anyone repeating this:

1. **A placeholder must settle asynchronously.** Resolving inline let React run
   effects before the gateway store finished initializing, producing a
   `Cannot access 'gateway' before initialization` TDZ that looked like a port
   defect and was purely an artifact of the stub.
2. **A placeholder needs stable referential identity.** Minting a new proxy per
   property read made every derived value change identity and drove React into
   `Maximum update depth exceeded`.

The Vite dev proxy's WebSocket handling is also broken on this platform — the
upgrade opens and dies with `ECONNRESET`/`1006`, and it kills the Vite process.
Straight at the gateway the same handshake is fine. The spike therefore proxies
**only** REST and dials the WS directly. In the shipped client this split
disappears, because the bundle is served from the backend and there is no proxy.

## What this changes about the plan

Nothing structural — the plan's architecture survives the spike intact. Three
corrections:

1. **Fase 1 is bigger than "2–3 days".** 128 members with 23 unsubscribe pairs on
   the boot path and several rich structured contracts (`connections`,
   `updates`, `getBootstrapState`, `getPoolLimits`) is a real audit, not a grep.
2. **Serving the bundle from the backend is not one of several options — it is
   forced.** It is the only shape in which the WS is not proxied and the token
   is not in a URL.
3. **Implement the bridge as a real module with tests, never as placeholders.**
   This spike's entire blocker was a placeholder that stringified to `"undefined"`
   and entered a routing key. The next phase needs typed returns for every
   member the boot path touches, and `stream.mjs` as the gate that must stay
   green.
4. **`stream.mjs` is the regression gate, not a one-off script.** It asserts on
   the protocol rather than on UI text, so it survives refactors that a
   screenshot diff would not.