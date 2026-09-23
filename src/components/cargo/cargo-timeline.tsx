import { Fragment } from 'react'
import { Ship, Train, Truck, Plane, Check, Anchor, Warehouse, MapPin, Home } from 'lucide-react'
import { legProgress, type TimelineStop } from '@/lib/cargo/payload'

/**
 * Where a container is, drawn from the route the forwarder returned.
 *
 * Dean, 22 Sep 2026: "All the details should be from the API ... these can be
 * different sometimes so the timeline representation should be dynamic to what
 * the API returns."
 *
 * So there is no template here. Four stops, six stops, a transhipment in the
 * middle, a rail leg into Hamilton: the component draws what it is handed. The
 * shape of the real data on that day ran from two stops to six across 25
 * shipments, so a fixed pickup / load / discharge / deliver picture would have
 * been wrong on the first one that transhipped.
 *
 * A stop is green once it has ACTUALLY happened. An estimate is drawn hollow
 * with its date underneath, because a date you are hoping for and a date that
 * happened should never look the same on a page somebody is acting on.
 *
 * The ship or truck on the leg under way sits where the calendar puts it, from
 * the dates the stops are due (Dean, 23 Sep 2026). The line up to it is that
 * estimate, so it can pass a rail hub the forwarder never confirms while the
 * hub's circle stays hollow. Amber once a port or the delivery is overdue.
 *
 * Server component. No state, so nothing to keep in user_page_state.
 */

const LEG_ICONS = {
  sea: Ship,
  rail: Train,
  road: Truck,
  air: Plane,
} as const

const STOP_ICONS: Record<string, typeof Anchor> = {
  PICKUP: Warehouse,
  PORT_OF_LOADING: Anchor,
  TRANSIT_HUB: MapPin,
  PORT_OF_DISCHARGE: Anchor,
  DELIVERY: Home,
}

/** "2026-09-27" → "27 Sep". The year only when it is not this one. */
function shortDate(iso: string | null, today: string): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[Number(m) - 1] ?? m
  return y === today.slice(0, 4) ? `${Number(d)} ${month}` : `${Number(d)} ${month} ${y}`
}

type LegState = 'travelled' | 'under-way' | 'ahead'

function Leg({
  mode,
  state,
  fraction = 0,
  overdue = false,
  note,
}: {
  mode: TimelineStop['legToNext']
  state: LegState
  fraction?: number
  overdue?: boolean
  note?: string
}) {
  const Icon = mode ? LEG_ICONS[mode] : null
  const moving = state === 'under-way'
  const filled = state === 'travelled' ? 1 : moving ? fraction : 0
  // The mode icon marks the middle of a leg; on the leg under way it marks where the cargo is.
  const at = moving ? fraction : 0.5
  const line = overdue ? 'bg-amber-500' : 'bg-[#025945]'
  const tone = state === 'ahead' ? 'text-gray-400' : overdue ? 'text-amber-600' : 'text-[#025945]'
  return (
    // A list item, not a div: an <ol> may only contain <li>, and a stop is one.
    // Narrow minimum so a six stop route fits a laptop; the leg stretches into whatever is left.
    <li className="flex min-w-6 flex-1 items-center pt-[24px]" aria-hidden="true" title={note}>
      <span className="relative block h-5 w-full">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gray-300" />
        {filled > 0 && (
          <span className={`absolute left-0 top-1/2 h-0.5 -translate-y-1/2 ${line}`} style={{ width: `${filled * 100}%` }} />
        )}
        {Icon ? (
          <span
            className={`absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 bg-white px-1 ${tone}`}
            style={{ left: `${at * 100}%` }}
          >
            <Icon className={moving ? 'h-5 w-5' : 'h-4 w-4'} strokeWidth={moving ? 2 : 1.75} />
          </span>
        ) : (
          moving && (
            <span
              className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${line}`}
              style={{ left: `${at * 100}%` }}
            />
          )
        )}
      </span>
    </li>
  )
}

function Stop({ stop, today }: { stop: TimelineStop; today: string }) {
  const Icon = STOP_ICONS[stop.type] ?? MapPin
  const done = stop.state === 'done'
  const current = stop.state === 'current'

  const ring = done
    ? 'bg-[#025945] text-white ring-[#025945]'
    : current
      ? 'bg-white text-[#025945] ring-[#025945] ring-[3px]'
      : 'bg-white text-gray-400 ring-gray-300'

  return (
    <li className="flex w-24 shrink-0 flex-col items-center text-center sm:w-28">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{stop.label}</p>
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ring-2 ${ring}`}>
        {done ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Icon className="h-4 w-4" strokeWidth={2} />}
      </span>
      <p className={`mt-2 text-sm font-medium ${current ? 'text-[#025945]' : 'text-gray-900'}`}>
        {stop.place ?? stop.code ?? '—'}
      </p>
      {stop.code && stop.place !== stop.code && (
        <p className="text-[11px] tabular-nums text-gray-400">{stop.code}</p>
      )}
      {stop.date ? (
        <p className={`mt-1 text-xs tabular-nums ${stop.actual ? 'text-gray-700' : 'text-gray-400'}`}>
          {shortDate(stop.date, today)}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-300">—</p>
      )}
      {stop.caption && (
        <p className={`text-[11px] ${stop.actual ? 'text-[#025945]' : 'text-gray-400'}`}>{stop.caption}</p>
      )}
    </li>
  )
}

export default function CargoTimeline({
  stops,
  today,
  className = '',
}: {
  stops: TimelineStop[]
  today: string
  className?: string
}) {
  if (!stops.length) {
    return (
      <p className={`text-sm text-gray-500 ${className}`}>
        The forwarder has not published a route for this shipment yet.
      </p>
    )
  }

  const progress = legProgress(stops, today)
  const reached = stops.reduce((last, s, i) => (s.state === 'upcoming' ? last : i), -1)
  const moving = progress ? stops[progress.leg + 1] : null
  const note =
    progress && moving
      ? `On the way to ${moving.place ?? moving.code ?? 'the next stop'}${
          moving.date ? `, due ${shortDate(moving.date, today)}` : ''
        }${progress.overdue ? ', and late' : ''}`
      : undefined

  return (
    // A six stop route does not fit a phone, so the row scrolls sideways inside
    // its own container and the page never does. Same pattern the invoicing nav
    // already uses.
    <div className={`relative -mx-4 overflow-x-auto px-4 pb-1 ${className}`}>
      {note && <p className="sr-only">{note}</p>}
      <ol className="flex min-w-max items-start justify-between gap-0">
        {stops.map((stop, i) => (
          <Fragment key={`${stop.type}-${stop.code ?? stop.place ?? i}`}>
            <Stop stop={stop} today={today} />
            {i < stops.length - 1 && (
              <Leg
                mode={stop.legToNext}
                state={progress?.leg === i ? 'under-way' : i < (progress ? progress.leg : reached) ? 'travelled' : 'ahead'}
                fraction={progress?.leg === i ? progress.fraction : 0}
                overdue={progress?.leg === i ? progress.overdue : false}
                note={progress?.leg === i ? note : undefined}
              />
            )}
          </Fragment>
        ))}
      </ol>
    </div>
  )
}
