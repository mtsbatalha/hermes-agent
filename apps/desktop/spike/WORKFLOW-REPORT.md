# Web port — real workflow verification

This is partial workflow coverage, not 100% desktop parity. The live preview is
`http://127.0.0.1:5176/spike.html`; the existing gateway is on port 9119.
No existing server was stopped or reconfigured. Changes are uncommitted.

## Reproduce

From `apps/desktop` with the preview and gateway running:

```bash
node spike/workflows.mjs
node spike/workflows.mjs --viewport 390x844
node spike/stream.mjs --label workflows-1280
node spike/stream.mjs --width 390 --height 844 --label workflows-390
```

`--viewport WxH` runs the same scenarios at another viewport (default 1280x900).
Below **760px** (47.5rem — the `RAIL_HIDDEN`/`BAR_HIDDEN` breakpoint in
`app/overlays/overlay-split-layout.tsx`) two controls change shape, and the suite
follows both paths. The settings nav collapses from a rail of per-section
buttons into a single `TabDropdown` trigger whose menu holds the sections
(`openSettingsSection`), and the collapsible sessions sidebar leaves the grid to
be revealed as a pinned edge overlay (`setNarrowSidebar`, see the "Mobile narrow
round" section). Both adapters no-op above the breakpoint, so one harness covers
both layouts: **all 14 scenarios pass at 1280x900 and at 390x844** (14/14 each,
`faults: []`).

The workflow harness writes [results.json](artifacts/workflows/results.json),
including renderer exceptions and REST status codes. It exits nonzero when a
scenario fails. Only the native file dialog is simulated, with a real browser
`File`; all bridge and gateway calls remain real. It deletes only its own upload
directory. Native dialog UX is therefore not covered by this automated test.
Boot/navigation failures are recorded as a failed `harness` result, and any
unhandled renderer exception fails the run even between individual scenarios.
A deliberately invalid preview URL was verified to exit 1 and write that failure;
the subsequent normal run restored the final artifact with all scenarios passed.

## Final results

(round 6, mobile narrow: **14/14 scenarios at 1280x900 and 14/14 at 390x844**,
faults: [] in both runs — see the "Mobile narrow round" section below.)

| Flow                          | What was actually verified                                                                                                                                                                                                                                                                                                             | Result            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Chat at 1280                  | Two real prompts; streaming events; switch back; no transcript leakage either direction                                                                                                                                                                                                                                                | Pass              |
| Chat at 390 × 844             | Same flows through the narrow layout, with the sessions sidebar as the edge overlay                                                                                                                                                                                                                                                    | Pass              |
| Native diagnostics / keychain | Unsupported controls are not offered; supported desktop log action preserved by unit test                                                                                                                                                                                                                                              | Pass              |
| Gateway reconnect             | Visible refusal, no false success; actual switching is still unsupported                                                                                                                                                                                                                                                               | Correctly refused |
| Gateway save → reload         | Real SSH entry saved through the settings form, page reloaded, entry read back through the bridge and re-rendered in the form                                                                                                                                                                                                          | Pass              |
| Appearance                    | Change Intro Splash, reload, verify persistence, restore original                                                                                                                                                                                                                                                                      | Pass              |
| URL context                   | Add and remove chip; no page-fetch or model-context claim                                                                                                                                                                                                                                                                              | Pass              |
| Browser file                  | Picker fixture → upload → gateway path → exact-byte readback → remove test upload                                                                                                                                                                                                                                                      | Pass              |
| Browser folder                | Visible unsupported explanation; no unhandled rejection                                                                                                                                                                                                                                                                                | Correctly refused |
| Attachment turn (NEW)         | Pick file → attach → send turn; the submitted `prompt.submit` frame's `@file:` ref resolved via `readFileDataUrl` to exactly the picked bytes; turn settled (Stop appeared, then cleared); agent's reply with the file contents visible in the transcript                                                                              | Pass              |
| Clipboard copy (NEW)          | Right-click session row → Copy ID → bridge `writeClipboard` → OS clipboard holds the session id, verified after a page reload; at 390 × 844 the row is reached through the sidebar overlay                                                                                                                                             | Pass              |
| Large paste (NEW)             | 30k-char paste converts to a `Pasted content` chip (editor emptied), stages via upload-stream, submit carries the canonical `pasted_content_*.txt` @file: ref; turn settles                                                                                                                                                            | Pass              |
| Image paste (NEW)             | PNG paste → attachment chip → submit → `image.attach` RPC into the managed staging dir → gateway answers `attached:true` (request-id correlated) → `vision_analyze` turn settles                                                                                                                                                       | Pass              |
| Drag-and-drop image (NEW)     | REAL Chromium drag (CDP `Input.dispatchDragEvent`) dropping a PNG on the rich input and on the composer root; the drop sheet/composer affordances hand off and clear; each drop stages one byte-identical file via upload-stream; the submitted turn carries exactly one `image.attach` the gateway ACKs `attached:true`; turn settles | Pass              |
| Terminal                      | Real xterm; keystrokes observed outbound and echoed by child; resize frame + new output; close socket (at 390 × 844 the scenario borrows a desktop-width pane — the docked bottom pane is not collapsible)                                                                                                                             | Pass              |

The eight-scenario workflow harness had **zero renderer exceptions** and **zero
failed REST responses** in the final run. (That was round 1; the round-5 run
records one timeline 404 — see "Not clean: one REST 404 in the final run".) The streaming gates still recorded
console 404 resource messages; their URLs were not captured by that gate and are
not attributed to favicon by assumption.

## Attachment-turn pass

The "complete file-context turn" gap above is now closed for the web-attachment
path. A ninth scenario (`attachment-turn`) drives the full flow — pick, attach,
send, settle — and asserts on the wire, not the DOM: the `prompt.submit` frame
cites `@file:` with a real gateway path, and reading that path back through the
bridge returns exactly the bytes the picked `File` held (the gateway copies
attachments into its own `attachments/` dir, so the cited path is the canonical
copy, not the staging UUID dir). Passing at 1280x900 and 390x844.

Careless-user probes around that flow (all throwaway, findings only):

- Empty Enter, attach-only send (chip submits, no text), double Enter, rapid
  Add-context clicks, canceled file picker, invalid URL (Attach disabled with
  explanatory copy), 17 MiB file: all behave. The oversized case toasts the
  refusal visibly — but as `selectPaths: File exceeds the 16 MiB gateway read
limit.`, leaking the internal bridge member name into user copy.
  **Fixed**: `readableError` now strips the `BridgeError` member prefix (detail
  field when present, message prefix across serialization), with a regression
  test in `notifications.test.ts`. The toast now reads "File exceeds the 16 MiB
  gateway read limit."
- MEASURED on the wire: the timeline index request went out as
  `...&profile=default&profile=default` — the path already carried `profile`
  and the web-bridge `api()` funnel appended its scope again. FastAPI reads the
  first value so nothing broke, but **fixed** in `transport.ts` (append only
  when absent) with a regression test in `transport-api.test.ts`.
- Turn cancel via the composer Stop button works; the composer recovers and the
  interrupted turn shows in the transcript. Reload mid-turn replays the user
  message and the in-flight reply survives. Draft text persists across reload.
- Killing the browser mid-turn and rebooting produced one transient 404 on
  `/api/sessions/{id}/timeline` (the interrupted session's row was not yet on
  disk when the client asked). Root-cause pass: the client's timeline loader
  already guards the only case that can 404 this way — a session minted this
  run skips the fetch until it has messages (`use-timeline-history.ts`,
  `sessionCreatedThisRun`), and the gateway persists the row + user message
  synchronously inside `prompt.submit` (`_persist_session_row_for_submit`), so
  by the time the submit frame is on the wire the row exists. The kill-after-
  submit → reboot sequence was re-driven four times with full request/response
  capture: zero 404s, zero requests even targeting the killed session's id
  (the rebooted client binds to the session via the sidebar row, whose read
  path never 404s). The original observation is consistent with a title/
  sidebar refresh racing the very first persistence; it could not be
  reproduced after four attempts and no code path in the current build can
  produce it. Left closed as not-reproducible rather than hardened against.
- Scenario-order finding: `terminal-ui` fails (PTY opens, zero bytes) when run
  immediately after `attachment-turn` in the same page session, reproducibly;
  it passes when `attachment-turn` runs after it. Isolated turn-then-terminal
  reproduces clean, so the trigger is the longer accumulated session state, not
  the turn itself. Worked around by ordering `attachment-turn` last; the
  underlying interaction is real, unreproduced in isolation, and left open.
- At 390x844 the layout-dependent scenarios were out of scope in that round and
  are covered now (see "Mobile narrow round" below). Correction to what is
  written a few lines above: the narrow settings surface is not an "accordion" —
  it is the same overlay with its nav collapsed into a `TabDropdown`, and the
  failure was the harness not knowing that control existed.

## Bugs reproduced and repaired

1. **Open logs** clicked a missing method and threw `TypeError`. Capability-gate
   both Settings and the root-error fallback. Hide the unavailable keychain
   toggle as well. Tests prove the missing-capability case and retain the native
   action when present.
2. **Save and reconnect** only wrote localStorage but told the renderer it had
   applied the connection. Reject with `BridgeError` before writing instead.
   A regression test was red against the old behavior.
3. **Files…** returned `FileSystemFileHandle.name` as if it were a server path.
   Upload bytes to the managed-file endpoint before returning the gateway path;
   use unique staging directories and disable overwrite. Check the current
   16 MiB read cap before allocating bytes. Propagate upload failure and handle
   picker cancellation; the renderer shows errors rather than producing a chip
   or an unhandled rejection.
4. **Save for next restart** wiped the SSH port, identity file and remote Hermes
   path and reported success. The renderer adopts the save response as current
   state, and that response carried only `sshHost`/`sshUser` — the stored entry
   was missing the same fields, so the data was gone rather than merely hidden.
   The descriptor is now persisted and echoed in full, the write is verified by
   read-back (a blocked or silently dropped write throws, so the renderer's
   existing "Could not save gateway settings" path is what the user sees), and
   `gatewayRunning` is read from `/api/status` instead of being asserted `true`
   in one member and derived in the other. `getConnectionConfig` also dropped a
   field that is not in the contract (`remoteTokenStoredPlain`) and four that
   are; it now returns exactly the contract's set.

   The `connection-persistence` scenario was run against the **previous** bundle
   first and failed there ("A successful save must not empty the fields it was
   given", with port/key/path blank), then passed against the rebuilt bundle.

One consequence is deliberately not "fixed": `getConnectionConfig` reports
`mode: 'local'`. This client is served by one gateway and cannot dial a remote or
SSH endpoint, so the mode card opens on Local even when a remote or SSH entry is
stored — the saved values reappear as soon as you pick that mode. Echoing the
stored mode instead would fabricate a profile remote-badge, a startup-profile
choice and a boot sign-in path for a host this client never contacted.

## Final checks

- Desktop `npm run typecheck`: pass (an initial run timed out; a subsequent run
  exposed TS2774 in the new guard, which was repaired; the final rerun passed).
- `npm run check --workspace @hermes/web-bridge`: **100 tests + typecheck passed**.
  The seven tests added with bug 4 were also run against a **reintroduced** copy
  of the old member (subset stored, no read-back, `gatewayRunning: true`); all
  seven failed, and the source was restored byte-for-byte (md5 verified) before
  the final green run.
- Relevant UI suites: **66 tests passed**.
- Vite spike build: passed, followed by workflow and both streaming gates on that
  final bundle.
- Contract audit, Prettier for changed code, `git diff --check`: passed.
- Targeted ESLint: no errors; one pre-existing `no-restricted-globals` warning
  in the gateway settings test.
- `CAPABILITY-MATRIX.md` is not Prettier-clean and is not made so here: running
  `prettier --write` on it reformats every table in the document (~350 lines of
  churn unrelated to this work). Its appendix is regenerated by the audit, which
  does run the formatter over its own output.
- Static degradation advisory: **exit 1**, remaining candidates recorded in the
  matrix. It is not a behavioral proof and was not weakened to make it green.

## Image-attach and clipboard round

This round extended the permanent suite from 9 to **12 scenarios** and closed
the last "still not verified" item from the previous round: image attachment
and clipboard on the web client. All twelve pass on the real gateway
(`faults: []`, bundle rebuilt before the run).

### Defects found (all substantiated on the live surface, then repaired)

1. **Three bridge members silently no-op'ing.** `saveImageBuffer`,
   `savePastedText` and `saveClipboardImage` were classified `cut` in the web
   bridge while the renderer's optional-chained calls assumed they exist. Every
   paste path died silently: no chip, no error toast, no wire frame (image
   submits went out text-only; a 30k-char paste stayed inline in the editor;
   the composer menu's "Paste image" was a dead end; unfocused paste did
   nothing). Repair: the three members now stage bytes through
   `POST /api/files/upload-stream` into `.hermes-web-attachments/<uuid>/`
   (`uploadBytesToManagedPath` + `managedUploadRoot` helpers in
   `packages/web-bridge/src/index.ts`; `selectPaths` refactored onto the same
   helpers, which also fixed a double-GET per batch),
   `manifest.ts`/`capability-classification.mjs` regenerated via the audit
   (`--write`), and six regression tests added to
   `packages/web-bridge/test/file-picker.test.ts` (web-bridge: **107/107**).
   Re-verified on the rebuilt bundle: chip appears, `image.attach` carries the
   managed path, gateway answers `attached:true`, `vision_analyze` runs and the
   agent describes the 4×2 red PNG correctly ("red").
2. **`e.trim is not a function` renderer fault (real product bug).** Captured
   repeatedly during paste traffic with a full stack:
   `cleanPath` (`src/lib/path-compare.ts`) ← `ancestorDirs` ← `filterIgnored`
   (`src/app/right-sidebar/files/ipc.ts`). A non-string path reaching the
   gitignore pass crashed as an UNCAUGHT pageerror — and the poll interval that
   calls `readProjectDir` has no catch, so the whole tree pass died. Repair:
   `cleanPath`/`comparisonPath` degrade garbage input (returning `/` / `''`)
   instead of throwing, `readProjectDir` rejects typed-garbage paths as
   `{ error: 'invalid-path' }` at the boundary, and `projectIdForCwd` /
   `projectNameForCwd` guard non-string project paths (mirroring the existing
   `(path || '').trim()` contract). Regression tests added in
   `path-compare.test.ts` and `ipc.test.ts`; after the fix, faults are **[]**.
3. **Gateway death after an interrupted turn.** A suite failure once left an
   image turn running at `browser.close()`; the gateway logged
   `Interrupted during API call.` + aux-title timeout and STOPPED LISTENING on
   9119, which the next boot surfaced as the boot-failure overlay
   ("Reconnecting to Hermes…"). The settle-first discipline now in every
   attach scenario (no turn left mid-flight at teardown) removes the trigger;
   noted as an ops hazard, not re-reproduced deliberately.

### Probe-infra lessons (harness bugs, not product bugs)

- `window.__submits` wraps only OUTBOUND frames; JSON-RPC replies (which don't
  echo the method name) need an inbound ring. `window.__gwrecv` (keep-last 400)
  was added, with ONE message listener per socket (a listener added per
  `send()` floods the ring with duplicates) — and the client opens MULTIPLE
  sockets, so every non-pty socket feeds the ring.
- Reply correlation must tolerate ids as strings and/or spaced
  (`"id": 48`): the wire prints `"id": 48` with a space.
- The mounted chat `<header>` hosts SessionActionsMenu, but on the web surface
  it is HIDDEN (w0 h0) — the copy affordance a web user actually gets is the
  sidebar row's context menu. The suite therefore drives
  **right-click row → "Copy ID"** and asserts the clipboard holds the session
  id (`20261006_205515_82627a`), surviving a reload.
- A fresh boot can land on the overview (composer placeholder ready, but no
  session open); `ensureChatOpen()` now opens the most recent sidebar row —
  "New session" would land on the draft view, which has no session menu.

### New permanent scenarios (spike/workflows.mjs, ordered before the final

attachment-turn, which stays last)

- `clipboard-copy`: seeds (or reuses) a session, right-clicks its sidebar row,
  clicks Copy ID, reloads, and asserts the OS clipboard holds the session id —
  the full `writeClipboard` bridge round trip with clipboard permissions
  granted at context level (the earlier hang was `writeText` pending on the
  headless permission gate).
- `image-large-paste`: 30k-char paste must convert to a `Pasted content` chip
  (`editorLength 0`), stage via upload-stream, and the submit must carry the
  canonical `pasted_content_<stamp>_<hex>.txt` @file: ref; turn settles.
- `image-paste-attach`: paste a 4×2 red PNG into the focused composer, assert
  the chip mounts, the `image.attach` RPC targets the managed staging dir, the
  gateway answers `attached:true` (correlated by request id), and the turn
  settles.

### Still not verified or implemented

- Browser directory import (unchanged; drag-and-drop images are covered in
  the later "Drag-and-drop image round" section).
- `saveClipboardImage` against a REAL OS clipboard image (headless has no
  pasteboard content; the menu flow is exercised with a stubbed
  `navigator.clipboard.read` in earlier probes — the member's upload path is
  unit-tested).
- Terminal right-click copy (kebab/context menus exercise the same
  `writeClipboard` member; the xterm canvas selection path is not covered).
- The gateway's post-interrupt exit (item 3) as a deliberate repro.

## Clipboard real-image paste round

This round added a **13th permanent scenario**, `clipboard-image-real-paste`,
closing the biggest remaining item above: `saveClipboardImage` driven by a REAL
image on the REAL browser clipboard and the REAL user gesture (composer
"Add context" → "Paste image" menu item). All thirteen pass on the real
gateway (`faults: []`); `attachment-turn` stays last and clean.

### Headless facts the scenario is built on (measured, not assumed)

- **CDP has no `Input.dispatchPasteEvent` in this Chromium (130)** — the method
  doesn't exist (`wasn't found` for undefined/`{}`/`{text}` payloads). The
  earlier idea of dispatching paste through CDP is dead here. A REAL keyboard
  Ctrl+V (CDP key events) does reach the composer, but delivers
  `types: []` when the clipboard holds no image — the flow that actually
  delivers an image is the menu item, so that is what the scenario drives.
- **`navigator.clipboard.write` DECODES the image on write.** An invalid PNG
  fails with `DataError: Failed to read or decode Blob for clipboard item`;
  `image/jpeg` fails with `NotAllowedError: Type image/jpeg not supported`.
  Only a real, decodable PNG goes in. The suite's `PNG_BYTES` constant was
  replaced by a canvas-generated 4×2 opaque-red PNG (`#ff0000`) — also picked
  up by the pre-existing `image-paste-attach` and `image-large-paste`
  scenarios.
- **Round-trip is NOT byte-exact:** write→read yields 88 bytes for an 89-byte
  source (Chromium re-encodes). Correct assertions are therefore (a) the staged
  file equals the BYTES READ BACK FROM THE CLIPBOARD, and (b) the staged file
  decodes to the source pixels (4×2, every pixel `[255,0,0,255]`).
- **The headless clipboard is private** to the Chromium instance: OS
  (PowerShell `Set-Clipboard`) content never appears in `clipboard.read()` and
  page writes never leak to the OS. `document.execCommand('copy')` with
  `setData('image/png', …)` and `<img>` selection do NOT place an image.
  Permissions granted per-origin: `clipboard-read` + `clipboard-write`
  (`clipboard-sanitized-write` is an unknown permission there).

### What the scenario asserts

1. `navigator.clipboard.write` of the real PNG succeeds and read-back holds
   `image/png` bytes (guard).
2. `saveClipboardImage` is wrapped (not replaced) to observe exactly ONE call
   returning a path under `.hermes-web-attachments`.
3. The chip mounts as an **`AttachmentPill` BUTTON** whose `aria-label` is
   `Preview <staged basename>` — probe showed NO `[role="img"]` element exists
   (the inner thumbnail `<img>` only loads later; Playwright's `getByRole('img')`
   matched via the button's accessible-name computation, while a DOM scan on
   `role="img"` never does — that false negative cost two suite runs). The
   scenario selects `button[aria-label^="Preview clipboard-image-"]` and strips
   the `Preview ` prefix before comparing against the staged basename.
4. Byte fidelity: staged file == clipboard bytes. Pixel fidelity: decodes to
   the 4×2 red source.
5. Cleanup in `finally` (chip remove + recursive DELETE of the staged UUID dir)
   so `attachment-turn` starts clean — verified: an earlier run's leaked chip
   converted the next scenario's submit into a stray `image.attach`.

### Harness hardening found during validation

- `image-large-paste` asserted the upload-stream request IMMEDIATELY after the
  chip label appeared, but staging is async (chip mounts first) — a slow
  gateway showed `delta=0` while all uploads later landed 200. Now polls up to
  15s before asserting.
- `image-paste-attach`'s wait for the `attached` reply was 20s; under a
  freshly-booted gateway the reply occasionally missed it. Raised to 45s.
- Ops note: relaunching the gateway REQUIRES
  `HERMES_DASHBOARD_SESSION_TOKEN=spike-token-123` (per spike/README); a
  tokenless relaunch boots fine and REST answers 200 but the WS never
  authenticates — the harness dies in the boot `waitForFunction` with the page
  stuck on "Reconnecting to Hermes…".

## Drag-and-drop image round

This round added a **14th permanent scenario**, `drag-drop-image`, closing the
drag-and-drop item. It drives a **real drag**, not a page-made one: the suite
opens a CDP session and calls `Input.setInterceptDrags {enabled:true}` followed
by `dragEnter` → `dragOver` → `drop` on `Input.dispatchDragEvent`. Chromium then
runs its OWN DnD pipeline, reads the PNG off disk and builds the `File` itself —
so the page receives a drop with `isTrusted:true`, `types` including `Files`,
and a `webkitGetAsEntry()`-backed item (`isDirectory:false`), exactly what an
Explorer/Finder drop produces. A page-made `DataTransfer` also reaches the
composer (probed: a synthetic drop created a chip on both targets), but it never
leaves the renderer and reports `isTrusted:false`, so it is kept only as a
fallback idea and the scenario asserts the trusted path.

### Measured behaviour the scenario is built on

- `Input.dispatchDragEvent` EXISTS and works in this Chromium 130 — unlike
  `Input.dispatchPasteEvent`, which is absent here. It demands
  `Input.setInterceptDrags` first, and `data` must be present
  (`{items: [], files: ['<absolute png path>'], dragOperationsMask: 1}` is the
  cleanest shape; omitting `files` yields no chip). Without `data` the call
  fails with "Invalid parameters".
- The composer has **two drop targets with two handlers**: the rich input
  (`handleInputDrop` — drop ON the text box) and the composer root
  (`handleDrop` — the drop-anywhere box). The scenario covers both.
- **The affordance hands off; it is never doubled.** These are two DIFFERENT
  containers. The chat-wide sheet (`chat-drop-overlay`, "Drop files to attach")
  is painted by `useFileDropZone` handlers mounted on
  `[data-slot="composer-bounds"]`, while the composer itself lives in the
  `FloatingComposerSurface` **portal** — a DOM sibling of that container, not a
  descendant. So a drag over the transcript shows the sheet, and crossing onto
  the composer fires `dragleave` on the zone (sheet stands down) and
  `dragenter` on the composer, which marks itself with `data-drag-active` and
  dims its own surface to `opacity-60`. Crossing back re-arms the sheet.
- Staging goes through `saveImageBuffer` → `upload-stream` into
  `.hermes-web-attachments/<uuid>/<name>`, and unlike the clipboard path it
  hands the bytes straight through — so fidelity is byte-exact, not merely
  pixel-equal.

### What the scenario asserts

1. The composer starts empty, and the hand-off sequence is driven for real:
   over the thread the sheet names the outcome (`opacity > 0.5`) and the
   composer is NOT marked; over the composer `data-drag-active` is set and the
   surface is dimmed while the sheet stands down; back over the thread the sheet
   re-arms and the composer clears. (The first version of this assertion
   demanded sheet AND composer simultaneously and failed — the product does a
   hand-off, and the test now documents the behavior that is actually there.)
2. Drop 1 lands ON the rich input: both indicators must clear, the observed
   `drop` event must be `isTrusted:true` with `types` including `Files` and
   exactly the real `{name, size, type:'image/png'}` payload, the upload-stream
   request lands (polled up to 15s — the chip mounts before the response), and
   exactly ONE `saveImageBuffer` call returns a `.hermes-web-attachments` path
   whose bytes read back IDENTICAL to the source PNG.
3. Drop 2 lands on the composer ROOT: the second staging is its own file, also
   byte-identical, then the chip is removed so the turn under test carries a
   single image.
4. Submit: exactly ONE `image.attach` frame cites the staged path and the
   dropped file name, its reply is correlated by request id and must read
   `attached:true`, and the turn settles (Stop appeared, then cleared).
5. `finally` removes every chip, recursively DELETEs each staged UUID dir
   through the bridge, restores the wrapped `saveImageBuffer`, drops the drop
   listener and the temp PNGs, and detaches the CDP session.

### Harness bugs found while validating (not product bugs)

- **Affordance assertion was wrong** (see 1 above): it assumed the overlay and
  the composer were active together; the real behavior is a hand-off between
  two different DOM trees. Fixed by asserting both halves of the hand-off plus
  the re-arm.
- **`image.attach` is asynchronous and can land AFTER `prompt.submit`.** Reading
  the outbound frame slice once, right after Enter, therefore sees zero attach
  frames. Worse, waiting on a global "some reply says attached" scan is
  satisfied instantly by an EARLIER image scenario's reply (`__gwrecv` keeps 400
  frames for the whole run), so the slice is read too early. The scenario now
  polls for THIS turn's `image.attach` frame and then for the reply correlated
  to that frame's id. The same root cause had made `attachment-turn` fail by
  reading the wrong index; it now reads its own turn's frames.
- **Turn-settle observation raced the turn.** Polling for the Stop button from
  the TEST after the attach asserts misses a turn that starts and finishes
  inside that window — the image scenarios then reported a false "never settled"
  and burned the whole 180s budget. The sampler now runs INSIDE the page and
  starts BEFORE the submit, so it cannot miss the window; the same fix was
  applied to the pre-existing `image-paste-attach`.

With those fixed, the run is **14/14 PASSED, `faults: []`**, and the new
scenario leaves no chip, no staged directory and no temp file behind (verified
against `C:\Users\Mateus\.hermes-web-attachments`).

### Not clean: one REST 404 in the final run (recorded, not fixed)

The final run's captured responses contain one failure:
`GET /api/sessions/20261007_025726_5ad558/timeline` → **404** (id minted by this
run's boot). This is the same family the earlier round documented as
unreproduced, so the honest status is "still observed, still not reproduced in
isolation": three back-to-back cycles of New session → fill → Enter (the narrow
window between the optimistic local user message and the gateway persisting the
row) all read their freshly minted timeline with **200**. The only code path
that can 404 this way is the guard in `use-timeline-history.ts`: it skips the
read while the session is `sessionCreatedThisRun` **and** has zero local
messages, so a local user message that exists before the row is on disk lets
the read through. Its consequence is bounded but sticky — the hook's `catch`
sets `failed = key`, and the page-forward effect early-returns while
`failed === key`, so that session's "Show earlier" rail stays disabled for the
rest of the page lifetime (it is caught, so no fault and no error toast). Not
repaired here: the round's mandate is the playtest, and the earlier bundling of
this same observation with the kill/reboot sequence makes it a product-level
question, not a test fix.

**Round 6 update:** the same 404 appeared in BOTH viewport runs of this round,
with a fresh id each time (`/api/sessions/20261007_043433_98c5a9/timeline` at
390x844 and `/api/sessions/20261007_043818_1c5854/timeline` at 1280x900), always
the session this run minted and never a fault. That matches the
`sessionCreatedThisRun` race described above; the item stays open as
product-level, not a test fix.

## Mobile narrow round (round 6)

This round made the layout-dependent scenarios work at the phone viewport, so
the whole suite now runs at **390x844** as well as **1280x900**: both runs are
**14/14 PASSED with `faults: []`** (`node spike/workflows.mjs` and
`node spike/workflows.mjs --viewport 390x844`). Only harness code changed — no
product change, no bundle rebuild — so the desktop run doubles as the
non-regression proof.

### What actually changes at 390x844 (measured, not assumed)

- **The settings NAV changes shape; the settings surface does not.** The
  breakpoint is **47.5rem (760px)** — `RAIL_HIDDEN`/`BAR_HIDDEN` in
  `app/overlays/overlay-split-layout.tsx`. Above it `OverlayNav` renders one rail
  button per section; below it the SAME nav collapses into a single
  `TabDropdown` trigger and the sections move into its menu. Both paths call
  `group.onSelect`, so the section that opens is identical — only the walk to
  the row differs. The harness takes the dropdown path when
  `viewport.width < 760` (`[data-slot="dropdown-menu-trigger"]:has(.codicon-chevron-down)`,
  then `[role="menuitem"]` with the section label). It is not an "accordion" and
  nothing is missing from the surface — the four settings scenarios failed
  before only because the harness did not know the collapsed control existed.
- **The sessions sidebar becomes an edge OVERLAY.** `sessions` is `collapsible`,
  so narrow drops it from the grid (`renderer/tree-group.tsx` keeps only
  non-collapsible panes) and `renderer/narrow-overlays.tsx` reveals it as a
  pinned overlay (`[data-narrow-overlay="sessions"]`, width
  `min(overlayWidth, 85vw)` — measured **260 × 824** at 390 × 844, two thirds of
  the viewport). Its rows are NOT in the DOM until it mounts. The titlebar
  button routes through `toggleSidebarOpen` → `revealNarrowPane` (a real toggle
  whose label flips between "Show sidebar" and "Hide sidebar"), and Escape
  closes it as the top escape layer. The new `setNarrowSidebar(open)` helper
  performs exactly that walk: open = titlebar button + `waitFor` + a 500ms paint
  wait; close = Escape + `waitFor({state:'detached'})`. It no-ops above the
  breakpoint.
- **The docked terminal pane did NOT become an overlay** (fixed in round 7 — it
  is a bottom SHEET now; the measurements below are what motivated that). It was
  declared `placement:'bottom'`, `height:'20vh'`, `lifecycleKeepAlive:true` and
  WITHOUT `collapsible` (`app/contrib/controller.tsx`), so the same overlay
  filter skipped it and it stayed in the grid. Measured pane geometry per boot viewport:
  1280x900 → 223x110 (`RESIZE:34;7`); 1100x800 → 174x90 (`RESIZE:26;6`);
  760x900 → 83x110 (`RESIZE:11;7`); **390x844 → 53x99 / `RESIZE:6;6`** — about
  six columns. The Hermes TUI (Ink) repaints per column, so a 23-character probe
  arrives interleaved with cursor moves and `workflow-terminal-probe` is never
  contiguous there (`page.waitForFunction` timed out). The PTY was alive; the
  pane was simply too narrow to echo a line. That is recorded as a real product
  limitation of the phone layout (see the open items below), not repaired here.

### How the two failing scenarios were adapted

- `terminal-ui` **used to borrow a desktop-width pane** (round 6): when
  `NARROW_NAV` it set the viewport to 1280x900 before opening the terminal. Round
  7 removed the borrow — the sheet carries the deck at the run's own viewport.
- `clipboard-copy` reveals the sidebar overlay before locating the session row,
  and dismisses it around the seeding turn — the composer sits UNDER the 260px
  overlay on a 390px viewport, so it cannot be filled while the sidebar is open
  (reveal → check for the seeded row → hide → seed turn → re-reveal →
  right-click row → "Copy ID" → reload + clipboard assertion).

### The one real timing trap (measured, three variants)

Widening back to 1280x900 is NOT what fixes the echo; **waiting between the
first PTY byte and the keystrokes is what breaks it**. Three probe variants, all
with the same pane box (223x110) and the same `RESIZE:34;7`:

| Variant | Widen                                        | Type                                  | Result                                                     |
| ------- | -------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| F1      | 390x844 → 1280x900 before the terminal opens | immediately after `receivedBytes > 0` | echoed (`workflow-terminal-probe` contiguous) at t≈1s      |
| F2      | same as F1                                   | after a 2s settle                     | **never** echoed (bytes plateau at 5540 across 15 samples) |
| F3      | only after 20s at 390x844                    | immediately after the first byte      | echoed at t≈1s                                             |

So the scenario never inserts a wait between the first byte and
`pressSequentially`. Separately, the other narrow failure mode — a PTY that opens
and delivers **zero** bytes — was traced to leaked gateway children, not layout:
interrupting a probe leaves `node.exe`/`OpenConsole.exe` processes under the
`hermes serve` PID, and while they are present the PTY degrades
(`receivedBytes: 0`, TUI spawn fails). Clearing them before a run is part of the
ops routine, and a failure of that shape must be checked against that before
being read as a product defect.

### Probe lessons

- Interacting with the titlebar during boot needs the onboarding overlay
  (`div[data-glass-opaque]`) to be gone first — it intercepts pointer events.
  The suite's boot gate (composer `data-placeholder` ready) already runs past it,
  so no extra wait was needed, but a titlebar interaction added EARLIER in the
  boot sequence should expect it.
- Session rows carry two different class signatures (`session-row.tsx`): the
  context-menu target used here is `button.block.w-full.text-left` (measured 166x18
  at 390x844); the row's card is a separate element.

## Still not verified or implemented

- Image paste, large-text paste and clipboard copy are now covered (see the
  "Image-attach and clipboard round" section); `saveClipboardImage` with a
  real clipboard image + real menu gesture is now covered too (see the
  "Clipboard real-image paste round"), and **real drag-and-drop of an image**
  onto both composer targets is covered (see the "Drag-and-drop image round").
  Browser directory import (dropping a FOLDER) remains open — the probe showed
  `webkitGetAsEntry().isDirectory:false` for a file drop, but no directory-copy
  path was driven.
- Backend garbage collection for retained staging: the scenario deletes its own
  UUID dirs, but nothing reclaims dirs orphaned by a crashed or killed client,
  and ~114 such dirs from earlier rounds/probes are sitting in
  `C:\Users\Mateus\.hermes-web-attachments` — cleanup during a run deletes only
  what that run staged, so the residue compounds across sessions.
- Full actions on every route, Git review, profile switching and multi-host
  registry. Some existing bridge families remain partial or inaccurately shaped.
- Auth on a public/gated deployment and WebSocket ticket exchange.
- Firefox/Safari/Android file-picker fallback. Unsupported browsers report why.
- Cleanup policy for retained upload staging; removing a chip is not server-side
  garbage collection. Multiple-file partial upload rollback is not implemented.
- Terminal socket close does not establish termination of the attach-enabled
  server child. This terminal is `hermes --tui`, not desktop shell parity.
- ~~**The phone layout's docked terminal is effectively unusable.**~~ **Fixed** —
  the deck now leaves the grid on a narrow viewport and is revealed as a bottom
  SHEET; `terminal-ui` runs at the run's own viewport, no borrowed width. See
  "Round 7 — the phone terminal is a bottom sheet" below.
- New bridge error copy is English; complete localization remains open.

The other thread's `spike/_inspect2.mjs` remains untouched and untracked.
Screenshots from the last streaming runs carry the `stream-final` label; the
earlier `stream-workflows-*` and `stream-connection-roundtrip*` sets are from
earlier bundles and are left in place.

## Round 7 — the phone terminal is a bottom sheet

Round 6 left one product decision open: the docked terminal deck, the only
`bottom` pane that is not `collapsible`, stayed in the grid at 390x844 and was
squeezed to **53x99 px / `RESIZE:6;6`** (~six columns) — a TUI line could never be
typed and read back, so `terminal-ui` borrowed a desktop width to run. That is
now closed.

**What changed** (harness-free; the app itself):

- One predicate decides who leaves the grid: `leavesGridOnNarrow` in
  `renderer/track-model.ts` — a `collapsible` rail OR a `placement: 'bottom'`
  tool deck. `tree-split`'s `paneGone`, `tree-group`'s `paneShown`, the tab-strip
  walk (`shownPanesInGroup`) and the overlay's own filter all read it, so no two
  of them can disagree about which panes are on screen.
- `NarrowOverlays` gained a third anchor. A bottom pane is no longer forced into
  the `left`/`right` edge rail: it renders as a **bottom sheet** — `inset-x-0
  bottom-0`, `height: 45vh` (`NARROW_SHEET_HEIGHT`), `data-narrow-sheet`, the
  same keep-alive guest (so the PTY is not recreated), the zone's tab strip when
  it has zone-mates, and Escape as its top layer. It deliberately has **no hover
  strip**: a full-width strip on the bottom edge would sit on the dock and the
  statusbar and steal their pointer events, so the sheet is revealed by its own
  toggle.
- `$narrowRevealed` (tree store) mirrors what the overlay is showing, and
  `toggleTerminalPane` (Ctrl+\`) reads it for DIRECTION on narrow. The docked
  `$terminalTakeover` boolean stays `true` behind the overlay, so it could not
  answer "open or close?" on its own.
- `revealTreePane` reveals the narrow overlay first, so EVERY open door inherits
  the sheet — Ctrl+Shift+\` (`view.newTerminal`), a preset, a plugin summon — the
  same way they all inherit the un-minimize. Guarded on `modeLayout.restoring`
  (a boot or preset must not pop a sheet nobody asked for) and on chrome-hidden
  panes (the overlay filter skips those, so a reveal could not surface them).

**Evidence.**

- Unit: `renderer/narrow-grid-exit.test.ts` (the predicate), the sheet cases in
  `renderer/narrow-overlays.test.tsx` (bottom anchor + 45vh + no hover strip +
  the side rail still sized by width), the narrow cases in
  `tool-pane-toggle.test.ts` (an opened deck dispatches the overlay reveal on
  narrow, and nothing on a wide viewport) and in
  `terminal/reveal-focus.test.ts` (Ctrl+\` flips the sheet, leaves the tree alone).
- Gate: the FULL suite is green at both shapes with the fix — **14/14 at
  390x844** (`faults: []`, kept as
  [artifacts/workflows/results-390x844.json](artifacts/workflows/results-390x844.json))
  and **14/14 at 1280x900** (`faults: []`, [artifacts/workflows/results.json](artifacts/workflows/results.json)).
  `terminal-ui` runs at the **run's own viewport** now — asserting the sheet
  spans the viewport width and is tall enough for a TUI — and the artifact
  records the sheet's box: **390x380 at 390x844** (`{"sheet":{"width":390,"height":380}}`).
  The phone artifact predates the `viewport` field below; its filename names the
  run.

**Harness changes this round** (test infrastructure, not product):

- `--only name[,name]` runs just the named scenarios in the file's own order —
  for a focused re-run of one scenario without waiting out the whole suite.
- The artifact records its own `viewport` (and `only`), because the same
  `results.json` backs both shapes and a committed artifact that cannot name its
  own viewport is not evidence.
- `dismissNotifications` now clears the COLLAPSED stack too ("Show N more
  notifications" / "Clear all"). A collapsed entry has no per-item Dismiss
  button, so the old loop found none and left the stack covering the titlebar —
  which is exactly how this machine's sticky shared-profile warning ("Another
  Hermes installation is using this profile") broke a run at the `Close settings`
  click. That toast is environmental and permanent here, not a product defect.
- The settings-close housekeeping between rounds is tolerant of that toast and of
  settings not being open at all (an `--only` run skips the rounds that open it);
  the scenario that needs it closed still asserts its own state.
