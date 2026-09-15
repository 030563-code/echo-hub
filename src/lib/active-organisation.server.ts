import 'server-only'

import { cookies } from 'next/headers'
import type { AuthzOk } from '@/lib/authz'
import { ACTIVE_ORG_COOKIE, resolveActiveOrg } from '@/lib/active-organisation'
import type { OrgCode } from '@/lib/organisations'

/**
 * The organisation this request is looking at, or null when the person holds
 * none.
 *
 * The ONE function every scoped page and action calls. It reads the hub_org
 * cookie and resolves it against auth.profile.organisations, so the answer is
 * always something the caller is allowed to see, whatever the cookie says.
 *
 * Jack's quote route runs without cookies: he resolves to his first
 * organisation, which is his only one.
 */
export async function activeOrganisation(auth: AuthzOk): Promise<OrgCode | null> {
  const jar = await cookies()
  return resolveActiveOrg(auth.profile.organisations, jar.get(ACTIVE_ORG_COOKIE)?.value)
}
