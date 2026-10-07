# @hermes/web-bridge

The capability bridge for Hermes' **web client** — the browser-side counterpart
to the Electron `preload.ts`, implementing the same `hermesDesktop` contract
declared in `apps/desktop/src/global.d.ts`.

## The two rules

1. **Every property is a real transport.** There is no `get` trap, no `has`
   trap, and no inert placeholder. A member either talks to the same-origin
   backend or throws a `BridgeError` naming the request that failed.
2. **Nothing returns a shape the renderer can mistake for the truth.** No
   stand-in whose fields serialize to `"undefined"` — that is the exact class
   of bug this package exists to prevent, and the reason a `has` trap that
   answered `true` for everything was removed: it made the renderer choose a
   routing branch for a capability that did not exist.

Cut members are **absent on purpose**. `desktop.hud?.open()` yields
`undefined` and the renderer's own optional-chaining guard takes the "no HUD
here" branch, which is what actually happened on this platform.

`capabilities()` is how the UI asks what exists, instead of probing members
with `in`:

```ts
const caps = window.hermesWeb.capabilities()
caps.bridge // 50 exposed members; presence alone does not prove feature completeness
caps.missing // 107 absent members: structural cuts AND not-yet-wired capabilities
caps.kindOf(name) // 'transport' | 'browser' | 'cut'
caps.surfaces // UI-facing surfaces with unavailableReason
```

## Status

**50 of 157** top-level contract members are exposed. The audit accounts for the
other 107 as absent; 49 column-A members are still unwired. This is accounting,
not a claim that every exposed family is complete: `applyConnectionConfig`, for
example, explicitly rejects because a gateway reconnect is not implemented.

Connection settings persist the full endpoint entry to `localStorage`, and the
write is **verified**: storage that throws, or that accepts the write and keeps
nothing, produces a `BridgeError` rather than a success-shaped answer the renderer
could toast. `getConnectionConfig` reads that entry back but reports
`mode: 'local'`, because a browser client is attached to the gateway that served
the page and cannot dial a remote or SSH endpoint.

File selection uploads the chosen browser file through `/api/files/upload-stream`
before returning a gateway path. Files over the current 16 MiB read cap and
browser-folder selections are rejected. Uploaded staging files remain on the
host until removed; a chip removal does not implement server garbage collection.

`src/manifest.ts` is **generated** — run `node apps/desktop/tools/audit-contract.mjs --write`.

## Development

The production configuration is same-origin: the bundle is served _by_ the
gateway, the session is an `HttpOnly` cookie the client never sees, and the
socket is same-origin. `devSessionToken` and `devGatewayOrigin` exist only so
the spike harness can point at a bare `hermes serve`, and are empty in
production.

```bash
npm run check --workspace @hermes/web-bridge # package typecheck + tests
node spike/workflows.mjs                   # from apps/desktop; live preview + gateway required
```

`tools/audit-contract.mjs` in the Desktop app is the gate that keeps this
package honest: it fails when a declared member is neither implemented nor cut,
when a member is both, when a cut has no copy, when an implemented member names
no endpoint, when `IMPLEMENTED_MEMBERS` and the object disagree, or when any key
holds `undefined`.

## Layout

| File                 | Role                                                       |
| -------------------- | ---------------------------------------------------------- |
| `src/index.ts`       | the bridge object, `capabilities()`, `IMPLEMENTED_MEMBERS` |
| `src/transport.ts`   | REST funnel, socket URLs, the PTY byte pump                |
| `src/unsupported.ts` | the cut registry and UI-facing surfaces                    |
| `src/manifest.ts`    | **generated** — the 157-member ledger                      |
