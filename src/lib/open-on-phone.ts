/**
 * The address to put in the "Open on phone" QR code.
 *
 * Keeps the origin, path and query exactly, so the phone lands on the same
 * page with the same filters. Drops the hash: it only scrolls, and it makes the
 * code denser for nothing.
 *
 * Never throws. Anything that does not parse as an http(s) address comes back
 * unchanged, so the dialog still shows something the user can read.
 */
export function phoneUrl(href: string): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }
  // Schemes without an origin (mailto:, about:) serialise it as "null".
  if (url.origin === 'null') return href
  return `${url.origin}${url.pathname}${url.search}`
}
