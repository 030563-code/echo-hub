'use server'

import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { PIPELINE_CONFIG, TEAM_PIPELINE_MAP } from '@/lib/pipeline-config'

interface CompleteOnboardingInput {
  display_name: string
  /** Optional region (HubSpot pipeline). Only sales users need one. */
  pipeline_id?: string
  password: string
}

interface CompleteOnboardingResult {
  success: boolean
  error?: string
}

/**
 * Finish onboarding for an invited user: set display name, optional region, and
 * password. Row-scoping fields (allowed_*) are DERIVED server-side from
 * PIPELINE_CONFIG — never trusted from the client (escalation defense). The
 * isolation columns are written via the service-role client because the
 * `authenticated` role has no UPDATE grant on them. Capabilities are NOT granted
 * here — an admin grants them per-user.
 */
export async function completeOnboarding(
  input: CompleteOnboardingInput
): Promise<CompleteOnboardingResult> {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  if (!input.display_name?.trim()) {
    return { success: false, error: 'Please enter your name' }
  }
  if (!input.password || input.password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' }
  }

  const admin = createAdminClient()

  // One-time guard: refuse to re-run once onboarding has set a display name.
  const { data: existing, error: existingErr } = await admin
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle()
  if (existingErr) {
    console.error('completeOnboarding existing-profile check error:', existingErr.message)
    return { success: false, error: 'Failed to load profile' }
  }
  if (existing?.display_name) {
    return { success: false, error: 'Profile already configured' }
  }

  // Derive row-scoping fields server-side from the chosen region, if any.
  let pipeline_id: string | null = null
  let allowed_depots: string[] | null = null
  let allowed_quote_templates: string[] | null = null
  let allowed_distributors: string[] | null = null
  let hubspot_team_id: string | null = null

  if (input.pipeline_id) {
    const pipeline = PIPELINE_CONFIG.find((p) => p.pipelineId === input.pipeline_id)
    if (!pipeline) return { success: false, error: 'Invalid region selection' }

    // If the invite carried a team, the chosen region must be the one mapped to it.
    const invitedTeam = user.user_metadata?.hubspot_team_id as string | undefined
    if (invitedTeam) {
      const expected = TEAM_PIPELINE_MAP[invitedTeam]
      if (expected && expected !== input.pipeline_id) {
        return { success: false, error: 'Selected region is not permitted for your team' }
      }
      hubspot_team_id = invitedTeam
    }

    pipeline_id = pipeline.pipelineId
    // Store the depot CODE (label), not the display name — RLS + SKU mapping key on it.
    allowed_depots = pipeline.allowedDepots.map((d) => d.label)
    allowed_quote_templates = pipeline.allowedTemplates.map((t) => t.value)
    allowed_distributors = pipeline.allowedDistributors
  }

  // Set the password in the user's own auth session.
  const { error: passwordError } = await supabase.auth.updateUser({ password: input.password })
  if (passwordError) {
    console.error('Password update error:', passwordError.message)
    return { success: false, error: 'Failed to set password' }
  }

  // Write the profile via service-role (isolation columns are grant-locked).
  const { error: profileError } = await admin.from('profiles').upsert({
    id: user.id,
    display_name: input.display_name.trim(),
    pipeline_id,
    allowed_depots,
    allowed_quote_templates,
    allowed_distributors,
    hubspot_team_id,
  })
  if (profileError) {
    console.error('Profile upsert error:', profileError.message)
    return { success: false, error: 'Failed to save profile' }
  }

  return { success: true }
}
