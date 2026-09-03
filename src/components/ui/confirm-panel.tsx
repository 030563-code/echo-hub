import { cn } from '@/lib/utils'

/**
 * The amber "you are about to write to the live CRM" panel.
 *
 * The class string was byte-identical at both HubSpot create dialogs and the
 * create-deal wizard adds a third use, which is the point at which copying it
 * again stops being cheaper than naming it.
 *
 * Presentational only, deliberately: the wizard's final step already IS the
 * review surface, so a modal on top of it would be a second confirmation for
 * one click.
 */
export function ConfirmPanel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-echo-yellow/40 bg-echo-yellow/5 p-3 text-sm text-gray-700 break-words',
        className,
      )}
    >
      {children}
    </div>
  )
}
