import { redirect } from 'next/navigation'
import { Toaster } from 'sonner'
import { getAuthorizedUser } from '@/lib/authz'
import { Shell } from '@/components/nav/shell'

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

  return (
    <>
      {/* The responsive shell (fixed rail on lg+, hamburger drawer below) is a
          client component; children are passed through so pages stay server-rendered. */}
      <Shell capabilities={[...auth.capabilities]} displayName={displayName}>
        {children}
      </Shell>
      <Toaster position="top-right" richColors />
    </>
  )
}
