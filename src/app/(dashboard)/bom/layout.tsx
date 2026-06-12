import { requireCapability } from '@/lib/authz'

// Gates the BOM/pricing module by bom.view + dark board surface. Data comes from
// the separate mfg Supabase project via the server-only mfg client.
export default async function BomLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('bom.view')
  return (
    <div className="-m-8 min-h-[calc(100vh-65px)] bg-[#111] text-[#e5e5e5]">{children}</div>
  )
}
