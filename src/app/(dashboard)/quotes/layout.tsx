import { requireCapability } from '@/lib/authz'

// Gates the entire /quotes/* subtree. Any user without quotes.view or
// quotes.create is redirected to the dashboard. The create pages additionally
// require quotes.create. (Admin/super-admin imply all capabilities.)
export default async function QuotesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['quotes.view', 'quotes.create'])
  return <>{children}</>
}
