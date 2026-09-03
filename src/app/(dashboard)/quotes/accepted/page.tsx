import { CheckCircle } from 'lucide-react'
import { StageQueue } from '../stage-queue'

export default async function AcceptedQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <StageQueue
      category="accepted"
      basePath="/quotes/accepted"
      title="Accepted Quotes"
      description="Quotes that have been accepted by the customer."
      errorTitle="Error loading accepted quotes"
      emptyIcon={<CheckCircle className="w-full h-full" />}
      emptyTitle="No accepted quotes found"
      emptyBody="No quotes have been accepted yet."
      searchParams={await searchParams}
    />
  )
}
