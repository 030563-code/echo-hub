import { Suspense } from 'react'
import { requireCapability } from '@/lib/authz'
import { PastCloseBanner } from '@/components/quotes/past-close-banner'
import { QuotesTabsOnly } from '@/components/quotes/quotes-tabs-only'
import { QuotesNav } from './quotes-nav'

// Gates the entire /quotes/* subtree. Any user without quotes.view or
// quotes.create is redirected to the dashboard. The create pages additionally
// require quotes.create. (Admin/super-admin imply all capabilities.)
//
// The past-close banner sits above the tabs so it shows on every one of them.
// It waits on HubSpot inside its own Suspense boundary with no fallback, so no
// tab ever waits for it: it appears when HubSpot answers, or not at all.
export default async function QuotesLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['quotes.view', 'quotes.create'])
  return (
    <>
      <QuotesTabsOnly>
        <Suspense fallback={null}>
          <PastCloseBanner />
        </Suspense>
      </QuotesTabsOnly>
      <QuotesNav />
      {children}
    </>
  )
}
