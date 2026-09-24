/**
 * Has a deal's quote gone out? Decided from what HubSpot logged.
 *
 * Dean, 24 Sep 2026: "the sales people dont move their deals from quotation requestion to quotation
 * sent. The rule should probably be that if we can detect that the quote url has gone out via email
 * automatically set it to quotation sent because hubspot doesnt do it themselves and the sales reps
 * send out emails via their personal gmail".
 *
 * A rep's Gmail is connected to HubSpot, which logs mail sent to a known contact and attaches it to
 * that contact's open deals. A published HubSpot quote has a public link that nobody but the
 * customer is sent. So an outgoing logged email on the deal that carries the link proves the quote
 * went out, and says when. Measured on 24 Sep 2026: 82 open deals sat before Quotation sent with the
 * link already in an email their rep had sent.
 *
 * Pure: run.ts fetches, this decides. Every refusal names its reason, because a report run counts them.
 */

export interface PipelineStage {
  id: string
  displayOrder: number
  isClosed: boolean
}

export interface Pipeline {
  id: string
  stages: PipelineStage[]
}

export interface DealFacts {
  id: string
  pipelineId: string
  stageId: string
  isClosed: boolean
  /** dealstage's property history, newest first, so the first entry is the stage it is in now. */
  stageHistory: { stageId: string; at: string }[]
}

export interface QuoteFacts {
  id: string
  /** hs_quote_link: set when the quote is published, cleared while it is back in draft. */
  link: string | null
  createdAt: string | null
}

export interface EmailFacts {
  id: string
  /** hs_email_direction: EMAIL is one the rep sent, INCOMING_EMAIL one they received. */
  direction: string | null
  /** hs_timestamp: when it was sent. */
  sentAt: string | null
  /** hs_email_text and hs_email_html together. */
  body: string
  /** Every To and Cc address. */
  recipients: string[]
}

export type SkipReason =
  /** The pipeline has no Quotation sent stage, or more than one. */
  | 'no_single_sent_stage'
  | 'closed'
  /** At Quotation sent already, past it, or in a stage that comes after it. */
  | 'not_before_sent'
  | 'no_published_quote'
  /** No logged email on the deal carries one of its quote links. */
  | 'link_not_emailed'
  /** Only in an email the rep received, a reply quoting it for instance. */
  | 'link_only_received'
  /** Every recipient on record is inside Echo Barrier, or none is on record. */
  | 'no_outside_recipient'
  | 'email_before_quote'
  /** A rep moved the deal back from Quotation sent after this email. */
  | 'email_before_move_back'

export type Decision =
  | { move: true; toStageId: string; quoteId: string; emailId: string; emailSentAt: string }
  | { move: false; reason: SkipReason }

/** The open stages that come before Quotation sent, in the pipeline's own order. In USA and EURO
 *  SALES that is Quote Request and Call; General pricing, Tender and Passed to Distributor come after. */
export function stagesBeforeSent(pipeline: Pipeline, sentStageId: string): string[] {
  const sent = pipeline.stages.find((s) => s.id === sentStageId)
  if (!sent) return []
  return pipeline.stages.filter((s) => !s.isClosed && s.displayOrder < sent.displayOrder).map((s) => s.id)
}

/** The link as it is looked for: no scheme, no trailing slash, lower case. Null for a bare domain,
 *  which would match every email that mentions the website. */
export function linkKey(link: string): string | null {
  const key = link.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return /^[^/\s]+\/\S+$/.test(key) ? key : null
}

const TOKEN_CHAR = /[a-z0-9_-]/

/** Whether a body carries the link: the whole host and path, and not the start of a longer link
 *  (quote links differ only in their last part). Also the percent-encoded form, which is how a
 *  click-tracking redirect wraps a link. */
export function carriesLink(body: string, link: string): boolean {
  const key = linkKey(link)
  if (!key) return false
  const haystack = body.toLowerCase()
  for (const needle of [key, key.replace(/\//g, '%2f')]) {
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const next = haystack.charAt(at + needle.length)
      if (!next || !TOKEN_CHAR.test(next)) return true
    }
  }
  return false
}

/** Echo Barrier's own addresses: any address a HubSpot user signs in with, and its domains. */
export function isInternal(address: string, userEmails: ReadonlySet<string>): boolean {
  const a = address.trim().toLowerCase()
  if (userEmails.has(a)) return true
  return /@echo-?barrier\.[a-z.]+$/.test(a)
}

const ms = (iso: string) => Date.parse(iso)

// When no email qualifies, the reason reported is the one that came closest.
const CLOSENESS: SkipReason[] = [
  'link_not_emailed',
  'link_only_received',
  'no_outside_recipient',
  'email_before_quote',
  'email_before_move_back',
]

export function decide(input: {
  deal: DealFacts
  pipeline: Pipeline | undefined
  /** automaticSentStageFor(deal.pipelineId). */
  sentStageId: string | null
  quotes: QuoteFacts[]
  emails: EmailFacts[]
  userEmails: ReadonlySet<string>
}): Decision {
  const { deal, pipeline, sentStageId } = input
  if (!sentStageId || !pipeline) return { move: false, reason: 'no_single_sent_stage' }
  if (deal.isClosed) return { move: false, reason: 'closed' }
  if (!stagesBeforeSent(pipeline, sentStageId).includes(deal.stageId)) return { move: false, reason: 'not_before_sent' }

  const published = input.quotes.filter((q): q is QuoteFacts & { link: string } => !!q.link && !!linkKey(q.link))
  if (published.length === 0) return { move: false, reason: 'no_published_quote' }

  // A deal a rep moved back from Quotation sent was moved back on purpose (a fresh request, say), so
  // only an email sent since then counts. An older one would drag it straight forward again.
  const wasSent = deal.stageHistory.some((h) => h.stageId === sentStageId)
  const notBefore = wasSent ? (deal.stageHistory[0]?.at ?? null) : null

  let best: { quoteId: string; emailId: string; sentAt: string } | null = null
  let reason: SkipReason = 'link_not_emailed'
  const closer = (r: SkipReason) => {
    if (CLOSENESS.indexOf(r) > CLOSENESS.indexOf(reason)) reason = r
  }

  for (const email of input.emails) {
    if (!email.sentAt || Number.isNaN(ms(email.sentAt))) continue
    for (const quote of published) {
      if (!carriesLink(email.body, quote.link)) continue
      if (email.direction !== 'EMAIL') {
        closer('link_only_received')
        continue
      }
      if (!email.recipients.some((r) => !isInternal(r, input.userEmails))) {
        closer('no_outside_recipient')
        continue
      }
      if (quote.createdAt && ms(email.sentAt) < ms(quote.createdAt)) {
        closer('email_before_quote')
        continue
      }
      if (notBefore && ms(email.sentAt) < ms(notBefore)) {
        closer('email_before_move_back')
        continue
      }
      // The first email that sent it is when it went out.
      if (!best || ms(email.sentAt) < ms(best.sentAt)) best = { quoteId: quote.id, emailId: email.id, sentAt: email.sentAt }
    }
  }

  if (!best) return { move: false, reason }
  return { move: true, toStageId: sentStageId, quoteId: best.quoteId, emailId: best.emailId, emailSentAt: best.sentAt }
}
