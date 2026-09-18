/**
 * Hand the browser the bytes the server built.
 *
 * The download actions return a document made per request rather than a link:
 * it never sits at an address somebody could guess, and there is nothing to
 * expire. That means every caller has to do this same blob and anchor dance, so
 * it lives here rather than being retyped on each screen that offers a
 * download.
 *
 * Browser only, by construction: it touches `document` and `atob`. No
 * 'server-only' guard because a client component imports it directly.
 */

export interface FactoryPdfBytes {
  filename: string
  base64: string
}

export function saveFactoryPdf({ filename, base64 }: FactoryPdfBytes): void {
  const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
    type: 'application/pdf',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
