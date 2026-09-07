/**
 * The page-state contract: what a page key is, how big a payload may be, and
 * the shape a stored row comes back in.
 *
 * Pure and client-safe on purpose (no `server-only`), because both halves need
 * it: the browser validates a key before spending a round trip, and the server
 * action validates the same key again before it reaches the database. The
 * database carries the same rule a third time as a CHECK constraint, and
 * tests/unit/page-state-key.test.ts reads the migration to prove the pattern
 * there is this pattern, so the three can never drift apart.
 */

/**
 * A page key names a SCREEN, never a person: the row is already scoped to one
 * user by its primary key, so putting a user id in the key would be both
 * redundant and a way to accidentally build a shared namespace.
 *
 * Shape: a lowercase kebab-case head, then any number of `:`-separated
 * segments, e.g. `raise-po`, `quote-builder:12345`,
 * `quote-builder:12345:edit:<uuid>`. Segments allow upper case, digits,
 * underscore and dash because they carry ids we do not own (HubSpot deal ids,
 * Supabase uuids).
 *
 * Not vulnerable to catastrophic backtracking: every repetition of the group
 * must begin with a literal `:`, which the preceding character class cannot
 * match, so there is exactly one way to split any candidate string. The length
 * cap below is checked BEFORE the pattern regardless.
 */
export const PAGE_KEY_RE = /^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)*$/

/** Matches the `length(page_key) <= 160` half of the database CHECK. */
export const PAGE_KEY_MAX = 160

/**
 * A cart, a wizard or a filter set is a few kilobytes. This is a guard against
 * a page persisting something it should not (a product catalogue, a base64
 * attachment), not a budget to spend.
 *
 * Deliberately BELOW the database's own 65536 CHECK. Postgres re-serialises
 * jsonb on the way in (a space after every colon, key order normalised), so a
 * payload measured at exactly the limit here can arrive over it there, and the
 * user would get an unexplainable database error instead of this module's
 * readable refusal. page-state-key.test.ts asserts the gap still exists.
 */
export const PAGE_STATE_MAX_BYTES = 60000

/** What the database itself refuses, which must stay strictly larger. */
export const PAGE_STATE_DB_MAX_BYTES = 65536

/** A fingerprint is a short digest, not a place to put data. Bounded because
 *  it sits outside the size check on `state` and reaches a public endpoint. */
export const PAGE_STATE_BASE_MAX = 400

export function isPageKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= PAGE_KEY_MAX &&
    PAGE_KEY_RE.test(key)
  )
}

/** A row as the browser sees it. `data` is unparsed: every consumer runs it
 *  through its own schema before touching it (see parsePageState below). */
export interface StoredPageState {
  data: unknown
  /** The fingerprint of the underlying record when this was saved, if the page
   *  has one. Compare with the current fingerprint to spot a stale draft. */
  base: string | null
  updatedAt: string
}

/** Byte length of the payload as it will be stored, so the browser, the server
 *  action and the CHECK constraint all measure the same thing. */
export function pageStateBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify(data ?? null)).length
}

/**
 * Stored state is DATA, never trusted structure. It was written by this user's
 * own browser, but it may have been written by an older version of the app
 * (a renamed field, a dropped column) or hand-edited, so every consumer parses
 * it and treats a parse failure as "no draft" rather than crashing the page.
 */
export function parsePageState<T>(
  raw: unknown,
  parse: (value: unknown) => T | null,
): T | null {
  if (raw === null || raw === undefined) return null
  try {
    return parse(raw)
  } catch {
    return null
  }
}

/**
 * Is a saved draft still about the same underlying record?
 *
 * Only ever false when BOTH sides carry a fingerprint and they differ. A page
 * with nothing underneath it to go stale against (the raise-PO form, the deal
 * wizard) passes null and is never stale.
 */
export function isStale(savedBase: string | null, currentBase: string | null | undefined): boolean {
  if (!savedBase || !currentBase) return false
  return savedBase !== currentBase
}
