/**
 * Web-client detection (browser client via @hermes/web-bridge).
 *
 * The web bridge CUTS `windowControls` from the desktop contract entirely
 * (BRIDGE_LEDGER kind:'cut'), while EVERY Electron window provides it —
 * including a plain Windows desktop, where `custom` is false (only WSLg sets
 * `custom: true`). So web-ness is the ABSENCE of the member, never the
 * `custom` flag: keying on `custom` would misread a plain Windows desktop as
 * web.
 *
 * Consumers: shell CSS keys on the `data-web-client` root attribute (see the
 * LayoutTreeRoot band override — the browser has no native titlebar to replace
 * the chat's session header, so that band mounts in the web client only).
 */

export function isWebClient(): boolean {
  try {
    return typeof window !== 'undefined' && window.hermesDesktop?.windowControls === undefined
  } catch {
    return false
  }
}

/** Stamp `data-web-client` on <html> once, before first paint, when web. */
export function markWebClientRoot(): void {
  if (!isWebClient()) {
    return
  }
  document.documentElement.setAttribute('data-web-client', 'true')
}
