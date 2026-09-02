/**
 * Tiny country flags for the currency picker.
 *
 * Inline SVG rather than emoji or an icon font: Windows renders regional
 * indicator pairs as bare letters (US, CA) instead of flags, and the CSP in
 * next.config.ts limits connect-src to Supabase and HubSpot, so a CDN sprite
 * would be blocked outright.
 *
 * Decoration only. The ISO code is always rendered as adjacent text, so these
 * are aria-hidden and carry no meaning of their own.
 */

export type FlagCode = 'US' | 'CA'

export function FlagIcon({ code, className = 'h-3 w-4' }: { code: FlagCode; className?: string }) {
  const shared = {
    viewBox: '0 0 20 15',
    className: `${className} shrink-0 rounded-[1px] ring-1 ring-black/10`,
    'aria-hidden': true as const,
    focusable: 'false' as const,
  }

  if (code === 'CA') {
    return (
      <svg {...shared}>
        <rect width="20" height="15" fill="#fff" />
        <rect width="5" height="15" fill="#D52B1E" />
        <rect x="15" width="5" height="15" fill="#D52B1E" />
        <path
          fill="#D52B1E"
          d="M10 3.4l.85 1.75 1.75-.45-.55 1.75 1.5.2-1.2 1.3 1.95 1.4-2.4.55.3 1.1-1.95-.3.2 2.2h-.9l.2-2.2-1.95.3.3-1.1-2.4-.55 1.95-1.4-1.2-1.3 1.5-.2-.55-1.75 1.75.45z"
        />
      </svg>
    )
  }

  // Seven bands rather than thirteen, and four stars rather than fifty: at
  // 16px the real counts turn into mud.
  return (
    <svg {...shared}>
      <rect width="20" height="15" fill="#fff" />
      {[0, 2, 4, 6].map((band) => (
        <rect key={band} y={(band * 15) / 7} width="20" height={15 / 7} fill="#B22234" />
      ))}
      <rect width="9" height={(15 / 7) * 4} fill="#3C3B6E" />
      {[
        [2.2, 1.6],
        [5.2, 1.6],
        [3.7, 3.4],
        [2.2, 5.2],
        [5.2, 5.2],
        [6.7, 3.4],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.55" fill="#fff" />
      ))}
    </svg>
  )
}
