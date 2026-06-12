import 'server-only'

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { hubspotFetch, HubSpotConfigError } from '@/lib/hubspot-client'
import { CAPABILITY_KEYS, type CapabilityKey } from '@/lib/capabilities'

/**
 * Centralised server-side authorization for the Hub.
 *
 * Two axes:
 *  - CAPABILITY (what actions/modules): the `user_capabilities` table, surfaced
 *    here as a `Set<CapabilityKey>`. `admin` / `profiles.is_super_admin` imply all.
 *  - SCOPE (which rows): `profiles.pipeline_id` (region) + `allowed_depots`.
 *
 * Every server action must re-check capability here; never trust the client.
 */

export interface AuthzProfile {
  id: string
  is_super_admin: boolean
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

  // Read the user's own capability rows (RLS permits reading own rows).
  const { data: capRows } = await supabase
    .from('user_capabilities')
    .select('capability')
    .eq('user_id', user.id)

  const granted = new Set<CapabilityKey>(
    (capRows ?? [])
      .map((r) => r.capability as CapabilityKey)
      .filter((c): c is CapabilityKey => ALL_CAPABILITIES.has(c))
  )

  // `admin` capability or the super-admin flag implies every capability.
  const capabilities = isSuperAdmin || granted.has('admin') ? new Set(ALL_CAPABILITIES) : granted

  return {
    ok: true,
    user: { id: user.id, email: user.email ?? undefined },
    profile: {
      id: profile.id,
      is_super_admin: isSuperAdmin,
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
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=pipeline`,
      { method: 'GET' }
    )
    if (!res.ok) {
      return { ok: false, error: res.status === 404 ? 'Deal not found' : 'Failed to verify deal access' }
    }
    const deal = await res.json()
    const pipelineId: string | null = deal?.properties?.pipeline ?? null

    if (!profile.pipeline_id || pipelineId !== profile.pipeline_id) {
      // Same response whether the deal exists in another pipeline or not —
      // don't leak existence to an unauthorized caller.
      return { ok: false, error: 'Forbidden: deal is outside your pipeline' }
    }
    return { ok: true, pipelineId, profile }
  } catch (err) {
    if (err instanceof HubSpotConfigError) return { ok: false, error: err.message }
    return { ok: false, error: 'Failed to verify deal access' }
  }
}
