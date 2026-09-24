import { AlertTriangle, Clock, FlaskConical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { XeroSendView } from '@/lib/po-xero-send'

const TONE: Record<XeroSendView['kind'], string> = {
  failed: 'border-red-200 bg-red-50 text-red-800',
  waiting: 'border-amber-200 bg-amber-50 text-amber-800',
  sandbox: 'border-gray-200 bg-gray-50 text-gray-600',
}

const ICON = { failed: AlertTriangle, waiting: Clock, sandbox: FlaskConical }

/**
 * What the Hub knows about an approved leg's hand-off to Xero, in the words the server chose.
 *
 * No state and no clock: the sentence arrives finished (src/lib/po-xero-send.ts), so the board,
 * the drawer and the order page cannot disagree about it. `small` is the board card's size.
 */
export default function XeroSendNotice({ view, small = false }: { view: XeroSendView; small?: boolean }) {
  const Icon = ICON[view.kind]
  return (
    <p
      role={view.kind === 'failed' ? 'alert' : undefined}
      title={small ? view.message : undefined}
      className={cn(
        'flex items-start gap-1.5 rounded-md border',
        TONE[view.kind],
        small ? 'px-1.5 py-1 text-[10px] leading-snug' : 'px-3 py-2 text-sm',
      )}
    >
      <Icon className={cn('flex-shrink-0', small ? 'mt-px h-3 w-3' : 'mt-0.5 h-4 w-4')} />
      <span className={small ? 'line-clamp-3' : undefined}>{view.message}</span>
    </p>
  )
}
