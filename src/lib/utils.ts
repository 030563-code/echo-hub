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
 * A TIMESTAMP (created_at) is a real instant and is rendered in the viewer's
 * own zone, as before.
 */
export function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "—"
  const trimmed = dateStr.trim()
  const date = new Date(trimmed)
  // Better to show the raw value than "Invalid Date".
  if (Number.isNaN(date.getTime())) return trimmed
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(DATE_ONLY_RE.test(trimmed) ? { timeZone: "UTC" } : {}),
  })
}

export function formatRelative(dateStr: string | null) {
  if (!dateStr) return "—"
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return formatDate(dateStr)
}
