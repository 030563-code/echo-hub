import { Trophy } from 'lucide-react'
import { StageQueue } from '../stage-queue'

export default async function ClosedWonPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <StageQueue
      category="won"
      basePath="/quotes/won"
      title="Closed Won"
      description="Deals that closed successfully."
      errorTitle="Error loading closed-won deals"
      emptyIcon={<Trophy className="w-full h-full" />}
      emptyTitle="No closed-won deals found"
      emptyBody="No deals have been closed won yet."
      searchParams={await searchParams}
    />
  )
}
