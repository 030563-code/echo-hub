'use client'

/**
 * Loads the Echo Barrier wordmark for embedding in a generated quote PDF.
 *
 * The artwork lives in /public rather than being inlined as base64 in the
 * bundle, so it costs a request instead of ~48KB on every page load. Marked
 * 'use client' because the relative fetch only resolves in the browser.
 */

let cached: Promise<string> | null = null

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the logo.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Resolves to the wordmark as a data URL, or to undefined if it could not be
 * fetched — the PDF falls back to a type-set wordmark in that case, so a
 * missing asset must never block a rep from producing a quote.
 *
 * Memoized for the life of the page. A failed attempt is deliberately not
 * cached, so a transient network blip does not cost the logo on every
 * subsequent quote.
 */
export function loadQuoteLogo(): Promise<string | undefined> {
  if (!cached) {
    cached = fetch('/logo-quote.png')
      .then((response) => {
        if (!response.ok) throw new Error(`Logo fetch failed: ${response.status}`)
        return response.blob()
      })
      .then(blobToDataUrl)
  }

  const attempt = cached
  return attempt.catch((error) => {
    console.error('Quote PDF: could not load the wordmark, falling back to text.', error)
    if (cached === attempt) cached = null
    return undefined
  })
}
