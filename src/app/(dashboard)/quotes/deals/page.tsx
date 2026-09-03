import Link from 'next/link'
import { Plus, FileText } from 'lucide-react'
import { StageQueue } from '../stage-queue'

export default async function QuoteRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
      headerAction={
        <Link
          href="/quotes/create/manual"
          className="w-full sm:w-auto inline-flex items-center justify-center font-bold uppercase tracking-wider transition-all focus:outline-none focus:ring-2 border-2 rounded-none bg-echo-yellow text-black border-echo-yellow hover:bg-yellow-400 hover:border-yellow-400 focus:ring-yellow-500/50 px-6 py-3 text-sm font-medium"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Deal
        </Link>
      }
      searchParams={await searchParams}
    />
  )
}
