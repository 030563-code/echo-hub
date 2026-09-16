/**
 * Which organisation a person is looking at.
 *
 * One for the whole Hub (Dean, 15 Sep 2026): pick Canada under Invoicing, open
 * Quotes, and Quotes shows Canada. It travels as a cookie rather than in the
 * URL because every module has internal links, tabs, redirects and
 * revalidatePath calls that would each have to carry it, and missing one would
 * silently snap an admin back to their first organisation.
 *
 * The cookie is a PREFERENCE, never an authority. Every read resolves it
 * against the organisations the person actually holds, here, so a stale or
 * forged value can only ever pick between things they were allowed to see.
 *
 * Pure, so the rule is unit-tested; the cookie itself is read in
 * active-organisation.server.ts.
 */

import { isOrgCode, moduleHasOrg, type OrgCode } from '@/lib/organisations'
import { NAV_ITEMS, activeNavHref, type NavItem } from '@/lib/capabilities'

export const ACTIVE_ORG_COOKIE = 'hub_org'

/** A year. Switching organisation is rare, and the value is revalidated on
 *  every request anyway. */
export const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * The cookie's organisation when it is one the person holds, else their first
 * organisation, else null.
 *
 * Null means "nothing to show" and every caller must treat it that way. It is
 * what a person with no organisation rows gets, and returning everything
 * instead would quietly undo the scoping for exactly the people it exists for.
 */
export function resolveActiveOrg(held: readonly OrgCode[], cookieValue: string | null | undefined): OrgCode | null {
  if (held.length === 0) return null
  const wanted = String(cookieValue ?? '').trim()
  if (isOrgCode(wanted) && held.includes(wanted)) return wanted
  return held[0]
}

/**
 * Where to go after switching. Only a path inside this site: it must start
 * with exactly one slash, so `//evil.example` (a protocol-relative URL) and
 * anything with a scheme fall back to the dashboard.
 */
export function safeNextPath(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim()
  if (!/^\/(?![/\\])/.test(value)) return '/'
  if (/[\s\0]/.test(value)) return '/'
  return value
}

/**
 * Where the header switch lands after choosing an organisation.
 *
 * Dean, 16 Sep 2026: "you should be able to click on the flag at the top next
 * to Echo Barrier Hub to change the current loaded country." The sidebar's
 * per-module lists already do this, but each of those knows which module it is
 * under and only offers the organisations that module has. The header flag
 * sits above every module, so it has to work that out from the path.
 *
 * Stay on the current page when it is not organisation-scoped, or when its
 * module covers the chosen organisation. Otherwise go to the dashboard: landing
 * on Quotes for s.r.o., which has no sales pipeline, would be a page with
 * nothing to show and no explanation.
 */
export function nextPathAfterSwitch(pathname: string, code: OrgCode, items: NavItem[] = NAV_ITEMS): string {
  const path = safeNextPath(pathname)
  const href = activeNavHref(path, items)
  const item = href === null ? undefined : items.find((i) => i.href === href)
  if (!item?.module) return path
  return moduleHasOrg(item.module, code) ? path : '/'
}

