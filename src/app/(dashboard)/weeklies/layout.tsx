import { requireCapability } from '@/lib/authz'

// Gates the Weeklies tracker. Light theme (planning board, not an ops data board).
export default async function WeekliesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['weeklies.view', 'weeklies.edit'])
  return <>{children}</>
}
