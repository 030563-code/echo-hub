import { requireCapability } from '@/lib/authz'

// Gates the BOM/pricing module by bom.view. Light, like the rest of the Hub.
// Data comes from the separate mfg Supabase project via the server-only mfg client.
export default async function BomLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('bom.view')
  return <>{children}</>
}
