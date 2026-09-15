import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * The bearer check for machine endpoints (n8n cron, the phone-system feed).
 *
 * Lifted out of src/app/api/mrp/run/route.ts, which had the only copy, so the
 * next machine endpoint cannot get it subtly wrong. Three properties matter:
 *
 *  - FAILS CLOSED. A missing or empty secret rejects every request. An endpoint
 *    that runs open when its env var is unset is worse than one that is down,
 *    because nothing looks wrong.
 *  - Constant time, over sha256 digests, so neither the length nor a shared
 *    prefix of the secret leaks through timing.
 *  - Compares the WHOLE header including the scheme, so `Bearer x` and a bare
 *    `x` are not the same thing.
 */
export function bearerAuthorized(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  const got = createHash('sha256').update(header ?? '').digest()
  return timingSafeEqual(expected, got)
}
