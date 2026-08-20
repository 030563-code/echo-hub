'use client'

import { useLinkStatus } from 'next/link'
import { Loader2 } from 'lucide-react'

// useLinkStatus only works when rendered as a descendant of a <Link>.
export function LinkSpinner({ className = '' }: { className?: string }) {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return <Loader2 className={`w-3.5 h-3.5 animate-spin ${className}`} aria-hidden="true" />
}
