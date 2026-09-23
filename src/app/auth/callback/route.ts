import { createServerClient } from '@/lib/supabase/server'
import { isAgentUserId } from '@/lib/agent-account'
import { redirectToPath } from '@/lib/same-site-redirect'

// OAuth / magic-link / invite callback. Exchanges the code for a session, then
// routes: an invited user (carries hubspot_owner_id / team metadata, no profile
// yet) → /onboarding; everyone else → the dashboard. Never reads a client-
// supplied `next` param, so this can't be turned into an open redirect.
export async function GET(request: Request) {
  // Only the query is read from request.url. Its origin can be the Netlify deploy's own host, and
  // a redirect built from it would land a freshly signed-in person on a host where their new
  // session cookie does not exist (same-site-redirect.ts). Every redirect here is a relative path.
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) {
    return redirectToPath('/login?error=missing_code')
  }

  const supabase = await createServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return redirectToPath('/login?error=auth_callback_failed')
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Jack, the ANZ AI sales agent, may never hold a browser session. This is the
  // door a magic link or a password recovery actually comes through, so the
  // exchange is undone here rather than only refused later by the middleware.
  if (isAgentUserId(user?.id)) {
    await supabase.auth.signOut()
    return redirectToPath('/login?error=agent_account')
  }

  // If the user has no profile row yet (or no region set), send them to onboarding.
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('pipeline_id, display_name')
      .eq('id', user.id)
      .maybeSingle()

    const needsOnboarding = !profile || !profile.display_name
    if (needsOnboarding) {
      return redirectToPath('/onboarding')
    }
  }

  return redirectToPath('/')
}
