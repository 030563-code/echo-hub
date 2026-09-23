import { FileText } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { CreateDealButton } from '@/components/quotes/create-deal-button'
import { StageQueue } from '../stage-queue'

export default async function QuoteRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const auth = await getAuthorizedUser()
  const canCreate = auth.ok && auth.capabilities.has('quotes.create')
  return (
    <StageQueue
      category="quote_requests"
      basePath="/quotes/deals"
      title="Incoming Deals"
      description="Manage and process new deals from HubSpot."
      errorTitle="Error loading deals"
      emptyIcon={<FileText className="w-full h-full" />}
      emptyTitle="No deals found"
      emptyBody="There are no deals assigned to your HubSpot account at this time."
      showTime
      actionStyle="yellowOutline"
      headerAction={canCreate ? <CreateDealButton /> : undefined}
      searchParams={await searchParams}
    />
  )
}
