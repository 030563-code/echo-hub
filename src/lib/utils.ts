import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Money for the screen, in the deal's own currency.
 *
 * Replaces formatCurrency, which had zero callers and hardcoded
 * maximumFractionDigits: 0, so it silently dropped cents and was unusable for
 * a quote. Locale stays en-US because the documents are English; only the
 * currency varies.
 */
export function formatMoney(amount: number | null | undefined, currency = "USD") {
  if (amount == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date for a person to read: "September 5, 2026".
 *
 * en-US for the same reason formatMoney is: the screens and documents are
 * written for US readers.
 *
 * Two kinds of value arrive here and they must be treated differently. A
 * DATE-ONLY string ("2026-09-05", which is what expires_on, valid_from and
 * week_start_date hold) is parsed by the Date constructor as UTC midnight, so
 * in any America/* zone it renders a day EARLY unless it is formatted in UTC.
 * A TIMESTAMP (created_at) is a real instant and is rendered in `timeZone`
 * when one is given, otherwise in the zone of whatever process runs this. In a
 * client component that is the server's zone (UTC) on the first render and
 * the reader's in the browser, so pass one there: see formatRelative.
 */
export function formatDate(dateStr: string | null | undefined, timeZone?: string) {
  if (!dateStr) return "—"
  const trimmed = dateStr.trim()
  const date = new Date(trimmed)
  // Better to show the raw value than "Invalid Date".
  if (Number.isNaN(date.getTime())) return trimmed
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(DATE_ONLY_RE.test(trimmed) ? { timeZone: "UTC" } : timeZone ? { timeZone } : {}),
  })
}

/**
 * How long ago something happened: "Today", "3d ago", "2w ago", then the date.
 *
 * This renders on the server and again in the browser, and React requires the
 * two to match. Reading the clock and the process zone here made them differ:
 * Netlify renders in UTC and the reader does not, so a date near midnight fell
 * on a different day on each side and the Quotes board threw React's hydration
 * error (418). So it takes the reader's zone, and null means that is not known
 * yet (the server render and the render that hydrates it). With null it reads
 * neither the clock nor the zone and gives the plain date in UTC, the same on
 * both sides. <RelativeDate> supplies the zone once the page has hydrated.
 */
export function formatRelative(dateStr: string | null, timeZone: string | null) {
  if (!dateStr) return "—"
  if (timeZone === null) return formatDate(dateStr, "UTC")
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return formatDate(dateStr, timeZone)
}
