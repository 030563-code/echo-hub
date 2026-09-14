'use client'

// page-state: none (image fallback only)

/**
 * A person's round profile photo, or their initials when there is none.
 *
 * Initials sit on an echo-orange circle, which reads on both the white header
 * and the black sidebar. A photo that fails to load (deleted since the page
 * rendered, or a session that lapsed) falls back to the initials rather than
 * showing a broken image.
 */

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { initialsFor } from '@/lib/profile/avatar'

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-24 w-24 text-3xl',
} as const

export function Avatar({
  src,
  name,
  email,
  size = 'md',
  className,
}: {
  src: string | null
  name?: string | null
  email?: string | null
  size?: keyof typeof SIZES
  className?: string
}) {
  // Remember WHICH url failed rather than a plain flag, so a new photo gets a
  // fresh try without resetting anything in an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const who = name?.trim() || email?.trim() || ''
  const label = who ? `Profile photo of ${who}` : 'Profile photo'
  const base = cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full', SIZES[size], className)

  if (src && failedSrc !== src) {
    return (
      // Not next/image: its optimiser fetches the url from the server, without
      // the viewer's session cookie, and this route answers that with a
      // redirect to /login instead of the photo.
      // eslint-disable-next-line @next/next/no-img-element -- see the comment above: next/image cannot send the session cookie
      <img
        src={src}
        alt={label}
        decoding="async"
        className={cn(base, 'object-cover bg-gray-100')}
        onError={() => setFailedSrc(src)}
      />
    )
  }

  return (
    <span role="img" aria-label={label} className={cn(base, 'bg-echo-orange font-bold text-white select-none')}>
      <span aria-hidden="true">{initialsFor(name, email)}</span>
    </span>
  )
}
