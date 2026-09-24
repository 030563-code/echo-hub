'use client'

import { useSyncExternalStore } from 'react'

/**
 * The reader's own time zone, or null while it cannot be known yet.
 *
 * A server has no idea where its reader is, and Netlify's runs in UTC. A time
 * formatted in the local zone on the server and again in the browser therefore
 * differed, and React threw away the page with its hydration error (418).
 *
 * useSyncExternalStore gives the server render and the render that hydrates it
 * the same answer, the server snapshot (null), and then renders once more with
 * the browser's zone. A page reached by client-side navigation has nothing to
 * hydrate and gets the reader's zone on its first render. Same shape as the
 * login page's `ready`, for the same reason: setting state in an effect would
 * do this a render later, and the React Compiler lint refuses it.
 */
export function useViewerTimeZone(): string | null {
  return useSyncExternalStore(subscribe, readerTimeZone, () => null)
}

// The zone does not change under a mounted page, so there is nothing to
// subscribe to.
function subscribe() {
  return () => {}
}

let known: string | null | undefined

function readerTimeZone(): string | null {
  if (known === undefined) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    known = usable(zone) ? zone : null
  }
  return known
}

// A browser that cannot place itself reports "Etc/Unknown", and every
// formatter refuses that with a RangeError. Showing UTC, labelled, beats a page
// that will not render.
function usable(zone: string | undefined): boolean {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(0)
    return true
  } catch {
    return false
  }
}
