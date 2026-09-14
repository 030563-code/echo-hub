import { redirect } from 'next/navigation'
import { Toaster } from 'sonner'
import { getAuthorizedUser } from '@/lib/authz'
import { Shell, type ShellProfile } from '@/components/nav/shell'
import { loadOwnProfile, type OwnProfile } from '@/lib/profile/load-own-profile'
import { avatarSrc } from '@/lib/profile/avatar'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const auth = await getAuthorizedUser()

  // No session → login. Session but no profile (mid-onboarding) → onboarding.
  if (!auth.ok) {
    if (auth.error === 'User profile not found') redirect('/onboarding')
    redirect('/login')
  }

  const displayName = auth.user.email ?? 'User'

  // This layout wraps every dashboard page, so the header and sidebar must
  // render even when the profile read fails, including the window where this
  // code is live before the job title and photo columns exist. Any failure
  // just means no job title and initials instead of a photo.
  let own: OwnProfile | null = null
  try {
    own = await loadOwnProfile(auth.user.id)
  } catch {
    own = null
  }

  const profile: ShellProfile = {
    id: auth.user.id,
    email: auth.user.email ?? null,
    displayName: own?.displayName ?? null,
    jobTitle: own?.jobTitle ?? null,
    avatarSrc: avatarSrc(auth.user.id, own?.avatarUpdatedAt ?? null),
  }

  return (
    <>
      {/* The responsive shell (fixed rail on lg+, hamburger drawer below) is a
          client component; children are passed through so pages stay server-rendered. */}
      <Shell capabilities={[...auth.capabilities]} displayName={displayName} profile={profile}>
        {children}
      </Shell>
      <Toaster position="top-right" richColors />
    </>
  )
}
