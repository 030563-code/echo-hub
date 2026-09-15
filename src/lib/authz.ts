import 'server-only'

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { hubspotFetch, HubSpotConfigError } from '@/lib/hubspot-client'
import { resolveHubSpotOwnerId } from '@/lib/hubspot-owner'
import { CAPABILITY_KEYS, type CapabilityKey } from '@/lib/capabilities'
import { ORG_CODES, isOrgCode, pipelineForOrg, sortOrgs, type OrgCode } from '@/lib/organisations'

/**
 * Centralised server-side authorization for the Hub.
 *
 * Two axes:
 *  - CAPABILITY (what actions/modules): the `user_capabilities` table, surfaced
 *    here as a `Set<CapabilityKey>`. `admin` / `profiles.is_super_admin` imply all.
 *  - SCOPE (which rows): the organisations the person holds (`user_organisations`,
 *    every one for a super admin), plus `profiles.pipeline_id` (their own sales
 *    region) and `allowed_depots`.
 *
 * Every server action must re-check capability here; never trust the client.
 */

export interface AuthzProfile {
  id: string
  is_super_admin: boolean
  /**
   * The organisations this person may see, in registry order. Every one of
   * them for a super admin or an `admin` capability holder, otherwise their
   * rows in user_organisations. Empty means they see nothing in any scoped
   * module, and every caller must treat it that way.
   */
  organisations: OrgCode[]
  pipeline_id: string | null
  allowed_depots: string[]
  allowed_distributors: string[]
  allowed_quote_templates: string[]
}

export interface AuthorizedUser {
  id: string
  email?: string
}

export type AuthzOk = {
  ok: true
  user: AuthorizedUser
  profile: AuthzProfile
  capabilities: Set<CapabilityKey>
}
export type AuthzErr = { ok: false; error: string }
export type AuthzResult = AuthzOk | AuthzErr

const ALL_CAPABILITIES = new Set<CapabilityKey>(CAPABILITY_KEYS)

/** Resolve the current session user, their profile, and their capability set. */
export async function getAuthorizedUser(): Promise<AuthzResult> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'User not authenticated' }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, is_super_admin, pipeline_id, allowed_depots, allowed_distributors, allowed_quote_templates')
    .eq('id', user.id)
    .maybeSingle()

  if (error) return { ok: false, error: 'Failed to load user profile' }
  if (!profile) return { ok: false, error: 'User profile not found' }

  const isSuperAdmin = Boolean(profile.is_super_admin)

  // Read the user's own capability and organisation rows (RLS permits reading
  // own rows). Together, because every page pays for this.
  const [{ data: capRows }, { data: orgRows }] = await Promise.all([
    supabase.from('user_capabilities').select('capability').eq('user_id', user.id),
    supabase.from('user_organisations').select('organisation').eq('user_id', user.id),
  ])

  const granted = new Set<CapabilityKey>(
    (capRows ?? [])
      .map((r) => r.capability as CapabilityKey)
      .filter((c): c is CapabilityKey => ALL_CAPABILITIES.has(c))
  )

  // `admin` capability or the super-admin flag implies every capability.
  const capabilities = isSuperAdmin || granted.has('admin') ? new Set(ALL_CAPABILITIES) : granted

  // And every organisation. A row naming an organisation the code does not
  // know is dropped, exactly as an unknown capability key is.
  const organisations: OrgCode[] =
    isSuperAdmin || granted.has('admin')
      ? [...ORG_CODES]
      : sortOrgs((orgRows ?? []).map((r) => String(r.organisation)).filter(isOrgCode))

  return {
    ok: true,
    user: { id: user.id, email: user.email ?? undefined },
    profile: {
      id: profile.id,
      is_super_admin: isSuperAdmin,
      organisations,
      pipeline_id: profile.pipeline_id ?? null,
      allowed_depots: profile.allowed_depots ?? [],
      allowed_distributors: profile.allowed_distributors ?? [],
      allowed_quote_templates: profile.allowed_quote_templates ?? [],
    },
    capabilities,
  }
}

/** Just the capability set for the current user (empty if unauthenticated). */
export async function getCapabilities(): Promise<Set<CapabilityKey>> {
  const auth = await getAuthorizedUser()
  return auth.ok ? auth.capabilities : new Set<CapabilityKey>()
}

/** True if the current user holds `capability` (admin/super-admin implies all). */
export async function hasCapability(capability: CapabilityKey): Promise<boolean> {
  const caps = await getCapabilities()
  return caps.has(capability)
}

/** True if the current user holds at least one of `capabilities`. */
export async function hasAnyCapability(capabilities: CapabilityKey[]): Promise<boolean> {
  const caps = await getCapabilities()
  return capabilities.some((c) => caps.has(c))
}

/**
 * Page/layout guard: redirect to `/` unless the user holds at least one of
 * `required`. Returns the authorized context for the caller to reuse. Call at the
 * top of a server component for any capability-restricted module page.
 */
export async function requireCapability(
  required: CapabilityKey | CapabilityKey[]
): Promise<AuthzOk> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) redirect('/login')

  const needed = Array.isArray(required) ? required : [required]
  const allowed = needed.some((c) => auth.capabilities.has(c))
  if (!allowed) redirect('/')

  return auth
}

// ---------------------------------------------------------------------------
// Deal-level authorization (Quotes module — Phase 2). Combines the capability
// gate with region (pipeline) ownership. Kept here so the Quotes port wires in
// cleanly. A deal belongs to exactly one HubSpot pipeline; a non-admin may act
// on it only when the deal's pipeline matches their own `pipeline_id`.
// ---------------------------------------------------------------------------

export type DealAccessResult =
  | { ok: true; pipelineId: string | null; profile: AuthzProfile }
  | { ok: false; error: string }

const DEAL_ID_RE = /^\d+$/

/**
 * The deal-scope rule, shared by the read path (getDealDetails) and every
 * write (assertDealAccess). A non-admin may reach a deal they OWN in HubSpot,
 * any deal in their own pipeline, or any deal in the pipeline of an
 * organisation they hold (the same rule the Quotes lists apply when an admin
 * looks at an organisation's deals).
 *
 * Owner is in the rule because that is exactly how the deal LISTS are scoped:
 * getDealsByStage filters on hubspot_owner_id across the quote-request stages
 * of FOUR pipelines. Checking only the pipeline here meant the list showed rows
 * the detail page then refused, which surfaced as a 404. It hit every inbound
 * web-form request, because those all land in the Demo pipeline (1216642)
 * rather than the rep's own, and carry no deal value, which is why it looked
 * like an amount problem.
 *
 * Fails closed: an unresolvable owner id leaves the pipeline match as the only
 * way through, and the caller is refused rather than admitted.
 */
export async function isDealInScope(
  dealPipelineId: string | null,
  dealOwnerId: string | null,
  profile: { pipeline_id: string | null; organisations?: readonly OrgCode[] },
  email?: string
): Promise<boolean> {
  if (profile.pipeline_id && dealPipelineId === profile.pipeline_id) return true
  if (dealPipelineId && (profile.organisations ?? []).some((org) => pipelineForOrg(org) === dealPipelineId)) {
    return true
  }
  if (!dealOwnerId || !email) return false
  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return false
  const callerOwnerId = await resolveHubSpotOwnerId(email, accessToken)
  return !!callerOwnerId && callerOwnerId === dealOwnerId
}

export async function assertDealAccess(
  dealId: string,
  capability: CapabilityKey = 'quotes.view'
): Promise<DealAccessResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  const { profile, capabilities } = auth

  if (!capabilities.has(capability)) {
    return { ok: false, error: 'Forbidden: missing capability' }
  }

  // Validate the id BEFORE the super-admin short-circuit so a malformed id is
  // never trusted by any caller, regardless of role.
  if (!dealId || !DEAL_ID_RE.test(dealId)) {
    return { ok: false, error: 'Invalid deal id' }
  }

  // Super admins bypass the pipeline check.
  if (profile.is_super_admin) return { ok: true, pipelineId: null, profile }

  try {
    const res = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=pipeline,hubspot_owner_id`,
      { method: 'GET' }
    )
    if (!res.ok) {
      return { ok: false, error: res.status === 404 ? 'Deal not found' : 'Failed to verify deal access' }
    }
    const deal = await res.json()
    const pipelineId: string | null = deal?.properties?.pipeline ?? null
    const dealOwnerId: string | null = deal?.properties?.hubspot_owner_id ?? null

    if (!(await isDealInScope(pipelineId, dealOwnerId, profile, auth.user.email))) {
      // Same response whether the deal exists out of scope or not: don't leak
      // existence to an unauthorized caller.
      return { ok: false, error: 'Forbidden: deal is outside your pipeline' }
    }
    return { ok: true, pipelineId, profile }
  } catch (err) {
    if (err instanceof HubSpotConfigError) return { ok: false, error: err.message }
    return { ok: false, error: 'Failed to verify deal access' }
  }
}
