import { redirect } from 'next/navigation'
import { Toaster } from 'sonner'
import { getAuthorizedUser } from '@/lib/authz'
import { Sidebar } from '@/components/nav/sidebar'

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
    <div className="flex min-h-screen bg-gray-100">
      <Sidebar capabilities={[...auth.capabilities]} displayName={displayName} />

      {/* min-w-0 lets this flex item shrink below its content's intrinsic width so a
          wide board (kanban/table) scrolls INSIDE the content area instead of growing
          `main` past the viewport and sliding over the fixed sidebar. */}
      <main className="flex-1 ml-64 flex flex-col min-h-screen min-w-0">
        <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-lg font-bold text-gray-800 uppercase tracking-wide">Echo Barrier Hub</h2>
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 rounded-full bg-gray-200 border border-gray-300" />
          </div>
        </header>

        <div className="p-8 flex-1 overflow-auto min-w-0">{children}</div>
      </main>
      <Toaster position="top-right" richColors />
    </div>
  )
}
