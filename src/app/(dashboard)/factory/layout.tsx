import { requireCapability } from '@/lib/authz'
import { factoryLocale } from '@/lib/factory/locale.server'
import { FactoryNav } from './factory-nav'

/**
 * The manufacturer's two tabs.
 *
 * Gated here for the whole subtree, and again on each page: a layout and a page
 * render concurrently in Next, so the layout's redirect is what stops the
 * response, not what stops the page's query from starting.
 */
export default async function FactoryLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['factory.view', 'factory.update'])
  const locale = await factoryLocale()
  return (
    <div className="max-w-5xl mx-auto">
      <FactoryNav locale={locale} />
      {children}
    </div>
  )
}
