import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { TEAM_PIPELINE_MAP } from '@/lib/pipeline-config'
import OnboardingForm from './onboarding-form'

export default async function OnboardingPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Already onboarded → straight to the dashboard. An external account goes the
  // same way whatever its name says: this form offers a list of Echo Barrier
  // sales regions with their depots, which is not a picklist an outside company
  // should be looking at, let alone choosing from.
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, is_external')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.display_name || profile?.is_external) redirect('/')

  const meta = user.user_metadata ?? {}
  const defaultDisplayName =
    (meta.full_name as string) ||
    [meta.first_name, meta.last_name].filter(Boolean).join(' ') ||
    ''
  const suggestedPipelineId = meta.hubspot_team_id
    ? TEAM_PIPELINE_MAP[meta.hubspot_team_id as string]
    : undefined

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <OnboardingForm
        email={user.email ?? ''}
        defaultDisplayName={defaultDisplayName}
        suggestedPipelineId={suggestedPipelineId}
      />
    </div>
  )
}
