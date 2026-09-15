/**
 * Tiny country flags for the currency picker and the organisation switcher.
 *
 * Inline SVG rather than emoji or an icon font: Windows renders regional
 * indicator pairs as bare letters (US, CA) instead of flags, and the CSP in
 * next.config.ts limits connect-src to Supabase and HubSpot, so a CDN sprite
 * would be blocked outright.
 *
 * Decoration only. The code or the organisation's name is always rendered as
 * adjacent text, so these are aria-hidden and carry no meaning of their own.
 *
 * Every flag is simplified for 16px: seven bands rather than thirteen, a
 * double cross rather than the full shield, the crosses of the Union flag
 * without their fimbriation. At this size the real detail turns into mud.
 */

export const FLAG_CODES = ['US', 'CA', 'FR', 'SK', 'GB', 'AU', 'IE'] as const
export type FlagCode = (typeof FLAG_CODES)[number]

export function isFlagCode(value: unknown): value is FlagCode {
  return typeof value === 'string' && (FLAG_CODES as readonly string[]).includes(value)
}

export function FlagIcon({ code, className = 'h-3 w-4' }: { code: FlagCode; className?: string }) {
  const shared = {
    viewBox: '0 0 20 15',
    className: `${className} shrink-0 rounded-[1px] ring-1 ring-black/10`,
    'aria-hidden': true as const,
    focusable: 'false' as const,
  }

  switch (code) {
    case 'CA':
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

    case 'FR':
      return (
        <svg {...shared}>
          <rect width="20" height="15" fill="#fff" />
          <rect width="6.67" height="15" fill="#0055A4" />
          <rect x="13.33" width="6.67" height="15" fill="#EF4135" />
        </svg>
      )

    case 'IE':
      return (
        <svg {...shared}>
          <rect width="20" height="15" fill="#fff" />
          <rect width="6.67" height="15" fill="#169B62" />
          <rect x="13.33" width="6.67" height="15" fill="#FF883E" />
        </svg>
      )

    case 'SK':
      // Three bands and the shield as a plain white double cross on red.
      return (
        <svg {...shared}>
          <rect width="20" height="15" fill="#fff" />
          <rect y="5" width="20" height="5" fill="#0B4EA2" />
          <rect y="10" width="20" height="5" fill="#EE1C25" />
          <path d="M4.5 3.5h6v5.2c0 1.7-1.3 2.9-3 3.6-1.7-.7-3-1.9-3-3.6z" fill="#EE1C25" stroke="#fff" strokeWidth="0.5" />
          <rect x="7.1" y="4.6" width="0.8" height="5" fill="#fff" />
          <rect x="5.8" y="5.6" width="3.4" height="0.8" fill="#fff" />
          <rect x="6.3" y="7" width="2.4" height="0.8" fill="#fff" />
        </svg>
      )

    case 'GB':
      return (
        <svg {...shared}>
          <rect width="20" height="15" fill="#012169" />
          <path d="M0 0L20 15M20 0L0 15" stroke="#fff" strokeWidth="3" />
          <path d="M0 0L20 15M20 0L0 15" stroke="#C8102E" strokeWidth="1" />
          <rect x="8.5" width="3" height="15" fill="#fff" />
          <rect y="6" width="20" height="3" fill="#fff" />
          <rect x="9.25" width="1.5" height="15" fill="#C8102E" />
          <rect y="6.75" width="20" height="1.5" fill="#C8102E" />
        </svg>
      )

    case 'AU':
      // The Union canton as its crosses, the Commonwealth star under it, and the
      // Southern Cross as five dots on the fly.
      return (
        <svg {...shared}>
          <rect width="20" height="15" fill="#012169" />
          <path d="M0 0L10 7.5M10 0L0 7.5" stroke="#fff" strokeWidth="1.6" />
          <path d="M0 0L10 7.5M10 0L0 7.5" stroke="#C8102E" strokeWidth="0.5" />
          <rect x="4.25" width="1.5" height="7.5" fill="#fff" />
          <rect y="3" width="10" height="1.5" fill="#fff" />
          <rect x="4.6" width="0.8" height="7.5" fill="#C8102E" />
          <rect y="3.35" width="10" height="0.8" fill="#C8102E" />
          <circle cx="5" cy="11.5" r="1" fill="#fff" />
          {[
            [15, 3],
            [13.2, 6.6],
            [17.6, 6.2],
            [15.4, 9.4],
            [14.3, 12.2],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.55" fill="#fff" />
          ))}
        </svg>
      )

    case 'US':
    default:
      // Seven bands rather than thirteen, and six stars rather than fifty.
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
}
