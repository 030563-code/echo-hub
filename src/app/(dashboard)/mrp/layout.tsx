import { requireCapability } from '@/lib/authz'

// Gates the whole /mrp subtree (dashboard + warehouse override) by mrp.view.
// The module is light, like the rest of the Hub; the dark board wrapper is
// gone and the dashboard shell's own padding applies. The warehouse page
// additionally requires stock.edit, and the stock-write action enforces
// stock.edit server-side.
export default async function MrpLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('mrp.view')
  return <>{children}</>
}
