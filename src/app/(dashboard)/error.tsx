'use client'

import { ErrorRecovery } from '@/components/errors/error-recovery'

/**
 * Anything that throws inside the dashboard. The shell, the sidebar and the
 * header stay, so there is still a way out of the page that failed.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorRecovery error={error} reset={reset} />
}
