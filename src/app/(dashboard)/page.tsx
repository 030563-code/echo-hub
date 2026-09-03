import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { navSections, type CapabilityKey } from '@/lib/capabilities'
import { NAV_ICONS } from '@/lib/nav-icons'

export default async function DashboardHome() {
  const auth = await getAuthorizedUser()
  const caps = auth.ok ? auth.capabilities : new Set<CapabilityKey>()

  // The same sections the sidebar draws, so the two agree by construction
  // rather than by both being edited. Dashboard is the one ungrouped item and
  // it links back here, so the null-group section is dropped: a card that
  // reloads the page you are already on is noise.
  const sections = navSections(caps).filter((section) => section.group !== null)

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Welcome to the Echo Barrier Hub</h1>
      <p className="text-gray-600 mb-8">Your workstreams, gated by what you’re authorised to do.</p>

      {sections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500 max-w-2xl">
          You don’t have any module access yet. An administrator needs to grant you capabilities.
        </div>
      ) : (
        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.group}>
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
                {section.group}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {section.items.map((item) => {
                  const Icon = NAV_ICONS[item.icon]
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="group rounded-lg border border-gray-200 bg-white p-6 hover:border-echo-orange hover:shadow-sm transition-all"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <Icon className="w-6 h-6 text-echo-orange" />
                        <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-echo-orange transition-colors" />
                      </div>
                      <h3 className="font-bold text-gray-900">{item.label}</h3>
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
