import { requireCapability } from '@/lib/authz'

// Gates the Transport module + renders the dark "Monday.com board" surface used
// by the ported ERP boards. (-m-8 cancels the dashboard shell's light padding so
// the board fills the content area; full light/dark unification is a Monday
// design-session task.)
export default async function TransportLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('transport.view')
  return (
    <div className="-m-8 min-h-[calc(100vh-65px)] bg-[#111] text-[#e5e5e5]">{children}</div>
  )
}
