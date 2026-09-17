import { redirect } from 'next/navigation'
import { Toaster } from 'sonner'
import { getAuthorizedUser } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { Shell, type ShellProfile } from '@/components/nav/shell'
import { loadOwnProfile, type OwnProfile } from '@/lib/profile/load-own-profile'
import { avatarSrc } from '@/lib/profile/avatar'
import { factoryLocale } from '@/lib/factory/locale.server'
import { strings } from '@/lib/factory/strings'

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
  const activeOrg = await activeOrganisation(auth)

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

  // An outside company reads its rail in its own language. Internal accounts keep English.
  const factoryChrome = auth.profile.is_external
    ? await (async () => {
        const t = strings(await factoryLocale())
        return {
          labels: { '/factory': t.navManufacturing, '/factory/stock': t.navStock },
          signOut: t.navSignOut,
        }
      })()
    : null

  return (
    <>
      {/* The responsive shell (fixed rail on lg+, hamburger drawer below) is a
          client component; children are passed through so pages stay server-rendered. */}
      <Shell
        capabilities={[...auth.capabilities]}
        isExternal={auth.profile.is_external}
        navLabels={factoryChrome?.labels}
        signOutLabel={factoryChrome?.signOut}
        organisations={auth.profile.organisations}
        activeOrg={activeOrg}
        displayName={displayName}
        profile={profile}
      >
        {children}
      </Shell>
      {/* Dean, 16 Sep 2026: "please make the hub messages stay longer it goes
          past quick." Sonner's default is 4 seconds, which is not long enough to
          read a sentence like "Sent to the test address, not Bamida" before it
          goes. Ten, and a close button so a stack can be cleared by hand rather
          than waited out. Set here because there are 165 toast call sites and a
          default belongs in one place. */}
      <Toaster position="top-right" richColors duration={10_000} closeButton />
    </>
  )
}
