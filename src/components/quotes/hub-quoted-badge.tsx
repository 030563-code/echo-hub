import { cn } from '@/lib/utils'

/**
 * The Echo Hub's mark: an orange tile with a black EH, the Hub's own app icon in miniature.
 *
 * Dean, 23 Sep 2026: "a little EH echo hub orange logo at the bottom right of each deal on the
 * kanban board so we can see which deals are done through the hub and which are not". A deal with
 * no Hub quote carries nothing, so the mark reads as there or not there at a glance.
 *
 * A labelled image, so a screen reader says what it means rather than spelling out "E H". The
 * board's legend passes `decorative`, because the sentence beside it already says it.
 */
export function HubQuotedBadge({ decorative = false, className }: { decorative?: boolean; className?: string }) {
  return (
    <span
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': 'Quoted in the Echo Hub', title: 'Quoted in the Echo Hub' })}
      className={cn(
        'inline-flex h-5 shrink-0 select-none items-center justify-center rounded bg-echo-orange px-1 text-[10px] font-extrabold leading-none tracking-tight text-black',
        className,
      )}
    >
      EH
    </span>
  )
}
