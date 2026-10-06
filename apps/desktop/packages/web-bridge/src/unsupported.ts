/**
 * The explicit "not supported here" registry.
 *
 * This is the replacement for the spike's Proxy. The spike had two failure
 * modes and both were about the same mistake — pretending a member existed:
 *
 *   1. `new Proxy(target, { get: …inert, has: () => true })` made EVERY member
 *      look present, so the renderer picked a routing branch on a capability that
 *      did not exist.
 *   2. An inert placeholder serialized to the string "undefined", which became
 *      the composite scope `undefined::default`, which stopped
 *      `reportGatewayState` ever publishing 'open'.
 *
 * Here a member is one of exactly two things, and the difference is data, not a
 * trap:
 *
 *   - TRANSPORT / BROWSER — a real function on the bridge object. It calls the
 *     same-origin backend or a browser API, and it throws on failure.
 *   - CUT — absent from the bridge object, and listed in BRIDGE_STATUS with the
 *     copy the UI shows instead. The renderer reads it through
 *     `capabilities()`, never by calling a function that pretends.
 *
 * Absence is the honest signal: `desktop.hud?.open()` yields `undefined` and the
 * renderer's own guard takes the "no HUD here" branch, which is the truth. A
 * function that returned a fabricated object would not be.
 */

export type CapabilityKind = 'transport' | 'browser' | 'cut'

export type CapabilityRecord = {
  /** `transport` = same-origin gateway/REST, `browser` = a browser API, `cut` = not here. */
  kind: CapabilityKind
  /** For transports: the endpoint or browser API that backs it. */
  endpoint?: string
  /** What the user sees instead, when the member is cut. Honest copy, never a stub message. */
  copy?: string
}

export type CapabilityName = 'window' | 'overlay' | 'preview' | 'host' | 'browser-api' | 'gateway'

export type Capability = {
  /** A stable key for UI code to branch on. */
  name: CapabilityName
  /** What the surface is, in one line, for a settings or degraded-state panel. */
  label: string
  /** True when the web client can do this today. */
  available: boolean
  /** Populated when `available` is false — the honest copy to render. */
  unavailableReason?: string
}

/** UI-facing surfaces, derived from the cut families in CAPABILITY-MATRIX.md. */
export const CAPABILITY_SURFACES: readonly Capability[] = [
  {
    name: 'gateway',
    label: 'Gateway socket and REST',
    available: true
  },
  {
    name: 'browser-api',
    label: 'Clipboard, notifications, file pickers',
    available: true
  },
  {
    name: 'window',
    label: 'Window chrome and multi-window sessions',
    available: false,
    unavailableReason:
      'The browser frame is the frame. "Open in a new window" becomes "open in a new tab". There is only one window.'
  },
  {
    name: 'overlay',
    label: 'Floating HUD, pet and Quick Entry',
    available: false,
    unavailableReason: 'These are separate always-on-top OS windows. They are not available in the web client.'
  },
  {
    name: 'preview',
    label: 'Cropping and guest spellcheck inside a preview',
    available: false,
    unavailableReason: 'Not available in the web client. Previews are sandboxed iframes.'
  },
  {
    name: 'host',
    label: 'Host processes, bootstrap and the local registry',
    available: false,
    unavailableReason: 'Managed on the host that runs the gateway you are connected to.'
  }
] as const
