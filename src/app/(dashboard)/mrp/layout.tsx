import { requireCapability } from '@/lib/authz'

// Gates the whole /mrp subtree (dashboard + warehouse override) by mrp.view, and
// renders the dark board surface. The warehouse page additionally requires
// stock.edit, and the stock-write action enforces stock.edit server-side.
export default async function MrpLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('mrp.view')
  return (
    <div className="-m-8 min-h-[calc(100vh-65px)] bg-[#111] text-[#e5e5e5]">{children}</div>
  )
}
