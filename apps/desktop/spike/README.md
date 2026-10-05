# Fase 0 spike — Hermes Desktop renderer in a plain browser

Not product code. This directory exists to answer one question before the port
gets built:

> Does the Desktop conversation hold up outside Electron?

## What this is

`apps/desktop`'s renderer is already browser code — it never imports Node or
Electron directly. Native power arrives through one narrow typed object,
`window.hermesDesktop`, exposed by the Electron preload. This spike supplies
that object from a browser tab and points the **unmodified** renderer at a live
`hermes serve` gateway.

- `install-bridge.ts` — the stub bridge. REST and the gateway WebSocket are
  real; native-only capabilities are absent and recorded.
- `../spike.html` — entry point. Loads the bridge installer, then the real
  `/src/main.tsx`.
- `vite.config.ts` — the Desktop config plus a same-origin `/api` **REST** proxy
  to `127.0.0.1:9119`. The gateway WebSocket is deliberately NOT proxied: measured
  here, Vite's WS proxy opens the upgrade and then dies with `ECONNRESET`/`1006`,
  while the identical handshake straight at the gateway opens, receives
  `gateway.ready`, and stays up. The bridge therefore dials
  `ws://127.0.0.1:9119` directly. In the shipped client this split goes away,
  because the bundle is served from the backend and nothing is proxied.

Anything the boot path needs that is missing from the bridge is a genuine
finding about the web port, not a gap in the harness. Read them off the console:

```js
__spike.missing          // members the renderer asked for but we don't implement
__spike.accessed()       // every member touched during boot
```

## Run it

Terminal 1 — the gateway. The fixed session token lets the browser bridge
authenticate; a plain `hermes serve` mints a random one and injects it into the
SPA HTML, which is exactly the mechanism a browser client cannot rely on.

```bash
HERMES_DASHBOARD_SESSION_TOKEN=spike-token-123 \
  hermes serve --skip-build --port 9119 --host 127.0.0.1
```

Terminal 2 — the renderer. **Build and preview; do not use `vite dev`.**

```bash
npm install            # once, from the monorepo root
cd apps/desktop
npx vite build   --config spike/vite.config.ts
npx vite preview --config spike/vite.config.ts     # http://127.0.0.1:5176
```

Then open <http://127.0.0.1:5176/spike.html>.

## Checks

```bash
node spike/probe.mjs                        # boot, bridge surface, 1280x900
node spike/probe.mjs --width 390 --label narrow   # narrow viewport
node spike/stream.mjs                       # THE GATE: streaming + session switch
node spike/stream.mjs --width 390 --height 844 --label narrow
```

`stream.mjs` is the permanent gate and asserts on the wire protocol, not on
rendered text. It covers two flows and fails the build if either breaks:

1. **Streaming** — a message goes out and comes back token by token
   (`message.start` → `message.delta` → `message.complete`).
2. **Session switch** — two sessions created through the real UI, one message
   each, then both directions verified: a marker must appear exactly once while
   its session is inactive (the sidebar row only, never the transcript) and
   twice while active (row + transcript). The expectation follows the layout, so
   it holds at both desktop and phone width.

To exercise a tool rather than a plain reply:

```bash
node spike/stream.mjs --message "Use your shell tool to run: echo toolcard-ok."
```

Green at 1280×900 and at 390×844, in dev and in the production build.

Note on timing: a turn's deadline is 300s because a rate-limited upstream
provider makes the gateway hold the turn and retry (~60s × 3). A shorter budget
reports a stall that is not a client fault; when that happens the gate says so
explicitly instead of failing anonymously. See [FINDINGS.md](./FINDINGS.md).

`stream.mjs` exits non-zero until streaming is actually observed on the wire, and
currently exits 0 in dev and in the production build, at 1280×900 and at
390×844. To exercise a tool rather than a plain reply:

```bash
node spike/stream.mjs --message "Use your shell tool to run: echo toolcard-ok."
```

## Notes

- The store dump inside `stream.mjs` only works against `vite dev`, where Vite
  still serves `/src/*`. Against the production build it degrades to the
  protocol-level assertions, which are the actual proof.
- `spike/dist/` is build output and is git-ignored.
- Port 5174 is the Desktop renderer's own default and 5173 was already taken on
  this machine, so the spike uses 5175 (dev) / 5176 (preview).
- `--skip-build` avoids rebuilding the dashboard's own Vite bundle, which is not
  what is under test here.