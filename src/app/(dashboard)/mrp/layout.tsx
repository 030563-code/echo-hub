import { requireCapability } from '@/lib/authz'

// Gates the whole /mrp subtree by mrp.view. The module is light, like the rest
// of the Hub; the dark board wrapper is gone and the dashboard shell's own
// padding applies. Stock itself lives at /stock now (stock.view), with the
// counts and adjustments behind stock.edit; the old /mrp/warehouse override
// page is gone with it.
export default async function MrpLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('mrp.view')
  return <>{children}</>
}
