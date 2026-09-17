import { Info } from 'lucide-react'

/**
 * A small "what is this?" icon that reveals an explanation on hover or keyboard focus.
 *
 * Dean, 17 Sep 2026: "There should really be more clarity on some of these things maybe some small
 * information icons we can hover over and it reveals how to use each page."
 *
 * 🔴 No JavaScript and no client bundle. The reveal is `group-hover` plus `group-focus-within`, so
 * this drops into a server component and costs nothing, and a keyboard user reaches it by tabbing
 * rather than only a mouse user by hovering. The trigger is a real button for that reason: a bare
 * span is not focusable and the hint would be mouse-only.
 *
 * Keep the text to what somebody needs to ACT: what the thing is for, and what to do next. A
 * tooltip nobody can act on is decoration.
 */
export default function InfoHint({
  children,
  label = 'What is this?',
  align = 'center',
}: {
  children: React.ReactNode
  /** Read out by a screen reader in place of the icon. Say what it explains. */
  label?: string
  align?: 'center' | 'left' | 'right'
}) {
  const position =
    align === 'left'
      ? 'left-0'
      : align === 'right'
        ? 'right-0'
        : 'left-1/2 -translate-x-1/2'

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#025945]"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-40 mt-1.5 w-64 rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${position}`}
      >
        {children}
      </span>
    </span>
  )
}
