'use client'

import { ErrorRecovery } from '@/components/errors/error-recovery'

/**
 * The last resort, replacing Next's built-in "This page couldn't load".
 *
 * It renders outside the root layout, so it brings its own html and body and
 * cannot rely on the stylesheet. Everything it needs is inline.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <ErrorRecovery error={error} plain />
      </body>
    </html>
  )
}
