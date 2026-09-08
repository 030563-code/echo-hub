import 'server-only'

/**
 * One switch that decides who every Hub email actually reaches.
 *
 * Dean, 8 Sep 2026: "Lets make sure all emails first send to me during the E2E
 * testing we do." The manufacturing work adds mail to two parties who are not
 * us, Juraj and Bamida, and the transport round adds Cargo Partner. A purchase
 * order reaching a factory during a test is not a tidy mistake, it is a
 * building being asked to make something.
 *
 * So there is ONE variable, HUB_EMAIL_TEST_RECIPIENT, not one per feature.
 * Per-feature variables are exactly how one gets missed, and the one that gets
 * missed is the one that reaches a supplier.
 *
 * While it is set:
 *   - `to` becomes the override and nothing else,
 *   - `cc` and `bcc` are CLEARED, not redirected. Redirecting the `to` while
 *     leaving a real cc in place would still mail Juraj,
 *   - the real addresses come back under `intended`, so the n8n template can
 *     print "this would have gone to ..." in the body. That is what makes a
 *     test send verifiable rather than merely safe.
 *
 * INVOICE_EMAIL_TEST_RECIPIENT is the precedent this copies. It keeps working
 * unchanged and is deliberately not folded in here: the invoicing path is live,
 * and this should not touch it.
 */

export type RecipientLists = {
  to: string[]
  cc: string[]
  bcc: string[]
}

export type ResolvedRecipients = RecipientLists & {
  /** True when the test override sent this somewhere other than its real audience. */
  isTest: boolean
  /** Who it would have gone to. Null on a real send, where `to` already says so. */
  intended: RecipientLists | null
}

/** One address, a comma-separated string, or a list of either. */
export type RecipientInput = string | null | undefined | readonly (string | null | undefined)[]

/**
 * Split on commas, trim, drop the empties, and drop a repeat of an address that
 * is already in the list. Case-insensitive on the comparison, because an
 * address typed two ways is one mailbox, but the first spelling is kept so the
 * body prints what a person actually wrote.
 */
function normalise(input: RecipientInput): string[] {
  const raw = Array.isArray(input) ? input : [input as string | null | undefined]
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    for (const piece of String(entry ?? '').split(',')) {
      const address = piece.trim()
      if (!address) continue
      const key = address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(address)
    }
  }
  return out
}

/** The configured override, or '' when there is none. */
export function emailTestRecipient(): string {
  return String(process.env.HUB_EMAIL_TEST_RECIPIENT ?? '').trim()
}

/** True while every Hub email is being diverted to the test address. */
export function emailTestModeOn(): boolean {
  return emailTestRecipient() !== ''
}

/**
 * The only way a Hub feature may decide who receives an email.
 *
 * Call it with the real audience. What comes back is what to hand n8n.
 */
export function resolveRecipients(lists: {
  to: RecipientInput
  cc?: RecipientInput
  bcc?: RecipientInput
}): ResolvedRecipients {
  const intended: RecipientLists = {
    to: normalise(lists.to),
    cc: normalise(lists.cc),
    bcc: normalise(lists.bcc),
  }

  const override = normalise(emailTestRecipient())
  if (override.length === 0) {
    return { ...intended, isTest: false, intended: null }
  }

  return { to: override, cc: [], bcc: [], isTest: true, intended }
}

/**
 * A short line for the Hub's own screens. Nobody should have to read an
 * environment variable to know whether a real email left the building.
 */
export function sendDescription(resolved: ResolvedRecipients): string {
  if (!resolved.isTest) return `Sent to ${resolved.to.join(', ')}`
  const would = resolved.intended?.to.join(', ') || 'nobody'
  return `Sent to the test address (${resolved.to.join(', ')}), not ${would}`
}
