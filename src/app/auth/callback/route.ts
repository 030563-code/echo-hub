import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

// OAuth / magic-link / invite callback. Exchanges the code for a session, then
// routes: an invited user (carries hubspot_owner_id / team metadata, no profile
// yet) → /onboarding; everyone else → the dashboard. Never reads a client-
// supplied `next` param, so this can't be turned into an open redirect.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // If the user has no profile row yet (or no region set), send them to onboarding.
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('pipeline_id, display_name')
      .eq('id', user.id)
      .maybeSingle()

    const needsOnboarding = !profile || !profile.display_name
    if (needsOnboarding) {
      return NextResponse.redirect(`${origin}/onboarding`)
    }
  }

  return NextResponse.redirect(`${origin}/`)
}
