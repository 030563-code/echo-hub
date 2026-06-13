import Link from 'next/link'
import { FileText, ShoppingCart, Layers, Truck, Gauge, ArrowRight, type LucideIcon } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { NAV_ITEMS, satisfiesRequirement, type CapabilityKey } from '@/lib/capabilities'

const ICONS: Record<string, LucideIcon> = {
  FileText,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
}

export default async function DashboardHome() {
  const auth = await getAuthorizedUser()
  const caps = auth.ok ? auth.capabilities : new Set<CapabilityKey>()

  // Workstreams the user can actually open (exclude the Dashboard self-link).
  const modules = NAV_ITEMS.filter((i) => i.href !== '/' && satisfiesRequirement(caps, i.requires))

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Welcome to the Echo Barrier Hub</h1>
      <p className="text-gray-600 mb-8">Your workstreams, gated by what you’re authorised to do.</p>

      {modules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500 max-w-2xl">
          You don’t have any module access yet. An administrator needs to grant you capabilities.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {modules.map((m) => {
            const Icon = ICONS[m.icon] ?? FileText
            return (
              <Link
                key={m.href}
                href={m.href}
                className="group rounded-lg border border-gray-200 bg-white p-6 hover:border-echo-orange hover:shadow-sm transition-all"
              >
                <div className="flex items-center justify-between mb-3">
                  <Icon className="w-6 h-6 text-echo-orange" />
                  <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-echo-orange transition-colors" />
                </div>
                <h3 className="font-bold text-gray-900">{m.label}</h3>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
