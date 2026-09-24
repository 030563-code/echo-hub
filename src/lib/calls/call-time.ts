/**
 * When a call came in, in words, in a zone the caller of these functions names.
 *
 * The Calls page is rendered twice, once on the server and again in the
 * browser, and React requires the two to match. Netlify's server runs in UTC
 * and the people reading the page do not (the France office reads it from
 * Paris, the US office from the US), so a time formatted in "the local zone"
 * came out differently on each side and React threw its hydration error (418
 * in production) on every first load. Nothing here reads the process zone.
 * Every function is told which zone to use, and the page gets that from
 * useViewerTimeZone.
 *
 * `timeZone` is null while the reader's zone is not known yet, which is the
 * server render and the render that hydrates it. Those show UTC and say so.
 */

const FALLBACK_ZONE = 'UTC'

/** "15 Sept 2026". The day and the time are two lines on the call log: "15
 *  Sept, 10:08" alone left a reader guessing at the year on anything older than
 *  a week. */
export function callDate(iso: string, timeZone: string | null): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: timeZone ?? FALLBACK_ZONE,
  })
}

/** "09:05" in the reader's zone. "07:05 UTC" before that zone is known, so
 *  nobody takes the stand-in for their own clock in the moment it shows. */
export function callTime(iso: string, timeZone: string | null): string {
  const time = new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timeZone ?? FALLBACK_ZONE,
  })
  return timeZone === null ? `${time} UTC` : time
}

/** Both on one line, "15 Sept 2026, 09:05", for use inside a sentence. */
export function callWhen(iso: string, timeZone: string | null): string {
  return `${callDate(iso, timeZone)}, ${callTime(iso, timeZone)}`
}
