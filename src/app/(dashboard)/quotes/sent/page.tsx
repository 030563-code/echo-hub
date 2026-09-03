import { Send } from 'lucide-react'
import { StageQueue } from '../stage-queue'

export default async function SentQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <StageQueue
      category="quotation_sent"
      basePath="/quotes/sent"
      title="Sent Quotes"
      description="Quotes that have been sent to customers."
      errorTitle="Error loading sent quotes"
      emptyIcon={<Send className="w-full h-full" />}
      emptyTitle="No sent quotes found"
      emptyBody="You haven&apos;t sent any quotes yet."
      searchParams={await searchParams}
    />
  )
}
