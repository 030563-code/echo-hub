import { describe, it, expect } from 'vitest'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import {
  carriesLink,
  decide,
  isInternal,
  linkKey,
  stagesBeforeSent,
  type DealFacts,
  type EmailFacts,
  type Pipeline,
  type QuoteFacts,
} from '@/lib/quote-sent/rule'
import { automaticSentStageFor, quotationSentStageFor } from '@/lib/quote-sent/stage'

/**
 * Dean, 24 Sep 2026: reps do not move their deals from Quote Request to Quotation sent, so the Hub
 * moves a deal once HubSpot has logged an email carrying its quote link. This is the rule alone,
 * with invented deals, quotes and emails.
 */

const USA = HUBSPOT_PIPELINES.USA_SALES
const S = USA.stages

// USA SALES in HubSpot's own display order, with its closed flags.
const usaPipeline: Pipeline = {
  id: USA.id,
  stages: [
    { id: S.QUOTE_REQUEST, displayOrder: 0, isClosed: false },
    { id: S.CALL, displayOrder: 1, isClosed: false },
    { id: S.QUOTATION_SENT, displayOrder: 2, isClosed: false },
    { id: S.CLOSED_LOST, displayOrder: 3, isClosed: true },
    { id: S.CLOSED_WON, displayOrder: 4, isClosed: true },
    { id: S.PASSED_TO_DISTRIBUTOR, displayOrder: 5, isClosed: false },
    { id: S.TENDER, displayOrder: 8, isClosed: false },
    { id: S.QUOTATION_ACCEPTED, displayOrder: 9, isClosed: true },
    { id: S.GENERAL_PRICING, displayOrder: 10, isClosed: false },
  ],
}

const LINK = 'https://quotes.example.com/ab12-cd34'
const quote: QuoteFacts = { id: 'q-1', link: LINK, createdAt: '2026-09-20T09:00:00Z' }
const deal = (over: Partial<DealFacts> = {}): DealFacts => ({
  id: 'd-1',
  pipelineId: USA.id,
  stageId: S.QUOTE_REQUEST,
  isClosed: false,
  stageHistory: [{ stageId: S.QUOTE_REQUEST, at: '2026-09-01T08:00:00Z' }],
  ...over,
})
const email = (over: Partial<EmailFacts> = {}): EmailFacts => ({
  id: 'e-1',
  direction: 'EMAIL',
  sentAt: '2026-09-21T10:00:00Z',
  body: `Hello, here is your quote: ${LINK}\nKind regards`,
  recipients: ['buyer@customer.example'],
  ...over,
})
const users = new Set(['rep.one@echobarrier.com', 'rep.two@mail.example'])

function run(over: Partial<Parameters<typeof decide>[0]> = {}) {
  return decide({
    deal: deal(),
    pipeline: usaPipeline,
    sentStageId: automaticSentStageFor(USA.id),
    quotes: [quote],
    emails: [email()],
    userEmails: users,
    ...over,
  })
}

describe('decide: when a deal moves to Quotation sent', () => {
  it('moves a Quote Request deal once the rep has emailed its quote link to the customer', () => {
    expect(run()).toEqual({
      move: true,
      toStageId: S.QUOTATION_SENT,
      quoteId: 'q-1',
      emailId: 'e-1',
      emailSentAt: '2026-09-21T10:00:00Z',
    })
  })

  it('moves a deal at Call too, which also comes before Quotation sent', () => {
    expect(run({ deal: deal({ stageId: S.CALL }) }).move).toBe(true)
  })

  it('never moves a deal at or past Quotation sent, or in a stage that comes after it', () => {
    for (const stageId of [S.QUOTATION_SENT, S.PASSED_TO_DISTRIBUTOR, S.TENDER, S.GENERAL_PRICING]) {
      expect(run({ deal: deal({ stageId }) }), stageId).toEqual({ move: false, reason: 'not_before_sent' })
    }
  })

  it('never moves a closed deal', () => {
    expect(run({ deal: deal({ stageId: S.CLOSED_LOST, isClosed: true }) })).toEqual({ move: false, reason: 'closed' })
  })

  it('leaves a pipeline alone that has no single Quotation sent stage', () => {
    expect(run({ sentStageId: null })).toEqual({ move: false, reason: 'no_single_sent_stage' })
    expect(run({ pipeline: undefined })).toEqual({ move: false, reason: 'no_single_sent_stage' })
  })

  it('needs a published quote: one with a link', () => {
    expect(run({ quotes: [] })).toEqual({ move: false, reason: 'no_published_quote' })
    expect(run({ quotes: [{ ...quote, link: null }] })).toEqual({ move: false, reason: 'no_published_quote' })
  })

  it('needs the link in an email', () => {
    expect(run({ emails: [email({ body: 'Following up on our call.' })] })).toEqual({
      move: false,
      reason: 'link_not_emailed',
    })
  })

  it('does not count a link that only appears in an email the rep received', () => {
    expect(run({ emails: [email({ direction: 'INCOMING_EMAIL' })] })).toEqual({
      move: false,
      reason: 'link_only_received',
    })
  })

  it('does not count an email that went only to colleagues, or to nobody on record', () => {
    for (const recipients of [['colleague@echobarrier.com'], ['rep.two@mail.example'], []]) {
      expect(run({ emails: [email({ recipients })] }), recipients.join()).toEqual({
        move: false,
        reason: 'no_outside_recipient',
      })
    }
    // One outside address on the To or Cc line is enough.
    expect(run({ emails: [email({ recipients: ['colleague@echobarrier.com', 'buyer@customer.example'] })] }).move).toBe(true)
  })

  it('does not count an email older than the quote', () => {
    expect(run({ emails: [email({ sentAt: '2026-09-19T10:00:00Z' })] })).toEqual({
      move: false,
      reason: 'email_before_quote',
    })
  })

  it('respects a rep who moved the deal back: only an email since then counts', () => {
    const movedBack = deal({
      stageHistory: [
        { stageId: S.QUOTE_REQUEST, at: '2026-09-22T12:00:00Z' },
        { stageId: S.QUOTATION_SENT, at: '2026-09-15T12:00:00Z' },
        { stageId: S.QUOTE_REQUEST, at: '2026-09-01T08:00:00Z' },
      ],
    })
    expect(run({ deal: movedBack })).toEqual({ move: false, reason: 'email_before_move_back' })
    expect(run({ deal: movedBack, emails: [email({ sentAt: '2026-09-23T09:30:00Z' })] }).move).toBe(true)
  })

  it('dates the move by the first email that sent the link', () => {
    const decision = run({
      emails: [email({ id: 'e-late', sentAt: '2026-09-23T10:00:00Z' }), email({ id: 'e-early', sentAt: '2026-09-21T08:00:00Z' })],
    })
    expect(decision).toMatchObject({ move: true, emailId: 'e-early', emailSentAt: '2026-09-21T08:00:00Z' })
  })

  it('names the reason that came closest when several emails fall short', () => {
    const decision = run({
      emails: [
        email({ id: 'a', direction: 'INCOMING_EMAIL' }),
        email({ id: 'b', recipients: ['colleague@echobarrier.com'] }),
      ],
    })
    expect(decision).toEqual({ move: false, reason: 'no_outside_recipient' })
  })
})

describe('carriesLink and linkKey', () => {
  it('finds the link however the email wrote it', () => {
    expect(carriesLink(`see ${LINK}`, LINK)).toBe(true)
    expect(carriesLink('see QUOTES.EXAMPLE.COM/AB12-CD34.', LINK)).toBe(true)
    expect(carriesLink('see http://quotes.example.com/ab12-cd34/', LINK)).toBe(true)
    expect(carriesLink(`<a href="${LINK}">Your quote</a>`, LINK)).toBe(true)
    expect(carriesLink(`${LINK}?utm_source=mail`, LINK)).toBe(true)
    // How a click-tracking redirect carries it.
    expect(carriesLink('https://track.example/c?u=https%3A%2F%2Fquotes.example.com%2Fab12-cd34&x=1', LINK)).toBe(true)
  })

  it('never takes one quote link for the start of a longer one', () => {
    expect(carriesLink('see https://quotes.example.com/ab12-cd34x', LINK)).toBe(false)
    expect(carriesLink('see https://quotes.example.com/ab12-cd34-v2', LINK)).toBe(false)
  })

  it('never matches on a bare domain', () => {
    expect(linkKey('https://quotes.example.com/')).toBeNull()
    expect(carriesLink('visit quotes.example.com today', 'https://quotes.example.com')).toBe(false)
  })
})

describe('isInternal', () => {
  it('knows Echo Barrier domains and every HubSpot user address', () => {
    expect(isInternal('Rep.One@EchoBarrier.com', users)).toBe(true)
    expect(isInternal('someone@echobarrier.eu', users)).toBe(true)
    expect(isInternal('someone@echo-barrier.com', users)).toBe(true)
    expect(isInternal('rep.two@mail.example', users)).toBe(true)
    expect(isInternal('buyer@customer.example', users)).toBe(false)
    expect(isInternal('someone@notechobarrier.com', users)).toBe(false)
  })
})

describe('stages', () => {
  it('counts only the open stages before Quotation sent, in display order', () => {
    expect(stagesBeforeSent(usaPipeline, S.QUOTATION_SENT)).toEqual([S.QUOTE_REQUEST, S.CALL])
    expect(stagesBeforeSent(usaPipeline, 'no-such-stage')).toEqual([])
  })

  it('moves automatically only where a pipeline has exactly one Quotation sent stage', () => {
    expect(automaticSentStageFor(USA.id)).toBe(S.QUOTATION_SENT)
    expect(automaticSentStageFor(HUBSPOT_PIPELINES.EURO_SALES.id)).toBe(HUBSPOT_PIPELINES.EURO_SALES.stages.QUOTATION_SENT)
    expect(automaticSentStageFor(HUBSPOT_PIPELINES.AUSTRALIA_SALES.id)).toBe(
      HUBSPOT_PIPELINES.AUSTRALIA_SALES.stages.QUOTATION_SENT,
    )
    // UK SALES - NEW has two, Price List and Live Requirement: the rep's call.
    expect(automaticSentStageFor(HUBSPOT_PIPELINES.UK_SALES_NEW.id)).toBeNull()
    expect(automaticSentStageFor('no-such-pipeline')).toBeNull()
  })

  it('keeps the Mark as sent button where it was', () => {
    expect(quotationSentStageFor(USA.id)).toBe(S.QUOTATION_SENT)
    expect(quotationSentStageFor(HUBSPOT_PIPELINES.UK_SALES_NEW.id)).toBe(
      HUBSPOT_PIPELINES.UK_SALES_NEW.stages.QUOTATION_SENT_PRICE_LIST,
    )
    expect(quotationSentStageFor('no-such-pipeline')).toBeNull()
  })
})
