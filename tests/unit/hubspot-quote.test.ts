import { describe, it, expect } from 'vitest'
import {
  QUOTE_ASSOCIATION_TYPE_IDS,
  QUOTE_DRAFT_STATUS,
  QUOTE_PUBLISHED_STATUS,
  buildQuoteCreateBody,
  buildQuoteLineItemInputs,
  commentsToHtml,
  nextQuoteNumber,
  quoteExpiryDate,
  validateQuoteInput,
  type QuoteCreateInput,
} from '@/lib/hubspot-quote'

describe('association type ids (a wrong id fails SILENTLY in HubSpot)', () => {
  it('matches the ids read off a live published quote in this portal', () => {
    // Verified 2026-09-02 against quote 42607942261. HubSpot accepts a write
    // with the wrong id and simply renders a quote with no line items, or no
    // company, or one that refuses to publish. Nothing errors, so this test is
    // the only thing standing between a typo and a broken customer document.
    expect(QUOTE_ASSOCIATION_TYPE_IDS).toEqual({
      template: 286, deal: 64, lineItem: 67, contact: 69, company: 71, signer: 702,
    })
  })
})

describe('quoteExpiryDate', () => {
  it('reproduces the expiry HubSpot itself put on two live quotes', () => {
    // Jillian's quotes, read live: created 2026-09-01 expiring 2026-10-31, and
    // created 2026-09-02 expiring 2026-11-01. Sixty days, confirmed by the
    // portal rather than assumed.
    expect(quoteExpiryDate('2026-09-01')).toBe('2026-10-31')
    expect(quoteExpiryDate('2026-09-02')).toBe('2026-11-01')
  })

  it('crosses a month end, a year end and a leap day', () => {
    expect(quoteExpiryDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(quoteExpiryDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(quoteExpiryDate('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('THROWS on a date that would silently roll over', () => {
    // Date.UTC turns 2026-13-45 into a real date the following year, which
    // would put an expiry months out with nothing to show for it.
    expect(() => quoteExpiryDate('2026-13-45')).toThrow(/real yyyy-mm-dd/)
    expect(() => quoteExpiryDate('2023-02-29')).toThrow(/real yyyy-mm-dd/)
    expect(() => quoteExpiryDate('')).toThrow(/real yyyy-mm-dd/)
    expect(() => quoteExpiryDate('3 September 2026')).toThrow(/real yyyy-mm-dd/)
  })
})

describe('commentsToHtml', () => {
  it('escapes markup the rep typed, ampersand first', () => {
    expect(commentsToHtml('Ford & Sons <b>bold</b> "quoted"')).toBe(
      '<p style="margin:0;">Ford &amp; Sons &lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;</p>',
    )
  })

  it('does not double-escape an ampersand that was already an entity', () => {
    expect(commentsToHtml('&amp;')).toBe('<p style="margin:0;">&amp;amp;</p>')
  })

  it('gives each line its own paragraph, matching the portal editor', () => {
    expect(commentsToHtml('Line one\nLine two')).toBe(
      '<p style="margin:0;">Line one</p><p style="margin:0;">Line two</p>',
    )
    expect(commentsToHtml('Windows\r\nline endings')).toContain('</p><p')
  })

  it('returns an empty string for blank input so the property is omitted', () => {
    expect(commentsToHtml('')).toBe('')
    expect(commentsToHtml('   \n  ')).toBe('')
    expect(commentsToHtml(null)).toBe('')
  })
})

describe('nextQuoteNumber', () => {
  it('uses the Hub reference as-is for the first quote on a deal', () => {
    expect(nextQuoteNumber('EBUS26123', 0)).toBe('EBUS26123')
  })

  it('suffixes a regenerated quote, because a regenerate makes a NEW object', () => {
    // Two live quotes carrying the same number is what the rep would otherwise
    // send to the customer.
    expect(nextQuoteNumber('EBUS26123', 1)).toBe('EBUS26123-2')
    expect(nextQuoteNumber('EBUS26123', 4)).toBe('EBUS26123-5')
  })

  it('returns undefined for a blank reference so HubSpot numbers it', () => {
    expect(nextQuoteNumber('', 0)).toBeUndefined()
    expect(nextQuoteNumber(null, 2)).toBeUndefined()
  })
})

describe('buildQuoteLineItemInputs', () => {
  const lines = [
    { name: 'Echo Barrier H9', quantity: 499, price: 178, hs_discount_percentage: 10, hs_product_id: '1640186928', hs_sku: 'EBH9NA', description: 'Sound barrier' },
    { name: 'LTL Freight', quantity: '1', price: '1200', discount: 200, hs_sku: 'LTLNA' },
  ]

  it('serialises every value as a string, money at two decimals', () => {
    const [first] = buildQuoteLineItemInputs(lines, 'USD')
    expect(first.properties.quantity).toBe('499')
    expect(first.properties.price).toBe('178.00')
    for (const value of Object.values(first.properties)) expect(typeof value).toBe('string')
  })

  it('names the currency on every line', () => {
    // These line items are created STANDALONE and associated afterwards. An
    // unattached line item falls back to the portal company currency, which is
    // EUR on this account, so a USD quote would show EUR lines.
    const built = buildQuoteLineItemInputs(lines, 'usd')
    expect(built.every((l) => l.properties.hs_line_item_currency_code === 'USD')).toBe(true)
  })

  it('keeps the cart order in hs_position_on_quote', () => {
    const built = buildQuoteLineItemInputs(lines, 'USD')
    expect(built.map((l) => l.properties.hs_position_on_quote)).toEqual(['0', '1'])
  })

  it('carries a percentage and a per-unit discount as DIFFERENT properties', () => {
    const built = buildQuoteLineItemInputs(lines, 'USD')
    expect(built[0].properties.hs_discount_percentage).toBe('10')
    expect(built[0].properties.discount).toBeUndefined()
    expect(built[1].properties.discount).toBe('200.00')
    expect(built[1].properties.hs_discount_percentage).toBeUndefined()
  })

  it('never sends both discount properties, which HubSpot would stack', () => {
    const [built] = buildQuoteLineItemInputs([{ name: 'Both', quantity: 1, price: 100, hs_discount_percentage: 10, discount: 5 }], 'USD')
    expect(built.properties.hs_discount_percentage).toBe('10')
    expect(built.properties.discount).toBeUndefined()
  })

  it('omits an empty optional rather than sending a blank that overwrites', () => {
    const [built] = buildQuoteLineItemInputs([{ name: 'Bare', quantity: 1, price: 10, hs_sku: '', description: null }], 'USD')
    expect('hs_sku' in built.properties).toBe(false)
    expect('description' in built.properties).toBe(false)
  })

  it('never lets a zero or fractional quantity reach a customer-facing quote', () => {
    // HubSpot derives the line amount as price x quantity, so a 0 here is a
    // free line on a document the customer reads.
    const built = buildQuoteLineItemInputs([{ name: 'A', price: 10 }, { name: 'B', quantity: 2.4, price: 10 }], 'USD')
    expect(built.map((l) => l.properties.quantity)).toEqual(['1', '2'])
  })
})

describe('buildQuoteCreateBody', () => {
  const base: QuoteCreateInput = {
    title: 'Test - UR',
    expirationDate: '2026-11-02',
    quoteNumber: 'EBUS26123',
    comments: 'In stock in Baltimore',
    sender: { firstname: 'Jillian', lastname: 'Rocco', email: 'jillian.rocco@echobarrier.com', phone: '+13122785759' },
    templateId: '454422093232',
    dealId: '64568716933',
    contactId: '12388',
    companyId: '45934040176',
  }

  it('creates as a DRAFT, because a quote with no status cannot be edited in HubSpot', () => {
    // The guide, verbatim: "If not provided at creation, users will not be able
    // to edit the quote in HubSpot." Publishing is a separate PATCH.
    expect(buildQuoteCreateBody(base).properties.hs_status).toBe(QUOTE_DRAFT_STATUS)
    expect(QUOTE_PUBLISHED_STATUS).toBe('APPROVAL_NOT_NEEDED')
  })

  it('associates the template, which can ONLY be set at creation', () => {
    const { associations } = buildQuoteCreateBody(base)
    expect(associations[0]).toEqual({
      to: { id: '454422093232' },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 286 }],
    })
  })

  it('carries the deal, contact and company, and no line items by default', () => {
    // The Hub creates the quote FIRST and its line items second, so the
    // likeliest failure happens before any line item exists.
    const ids = buildQuoteCreateBody(base).associations.map((a) => a.types[0].associationTypeId)
    expect(ids).toEqual([286, 64, 69, 71])
  })

  it('omits the company association when the deal has none', () => {
    const ids = buildQuoteCreateBody({ ...base, companyId: null }).associations.map((a) => a.types[0].associationTypeId)
    expect(ids).toEqual([286, 64, 69])
  })

  it('inlines line items when a caller already holds their ids', () => {
    const ids = buildQuoteCreateBody({ ...base, lineItemIds: ['1', '2'] }).associations.map((a) => a.types[0].associationTypeId)
    expect(ids).toEqual([286, 64, 67, 67, 69, 71])
  })

  it('NEVER sends a property HubSpot computes or inherits', () => {
    // Each of these is overridden by HubSpot, or worse sticks and diverges from
    // the deal: the owner comes from the deal, domain/locale/language from the
    // template, currency from the deal, template type from the state change.
    const { properties } = buildQuoteCreateBody(base)
    for (const key of ['hubspot_owner_id', 'hs_domain', 'hs_currency', 'hs_language', 'hs_locale', 'hs_template_type', 'hs_quote_link', 'hs_quote_amount']) {
      expect(key in properties).toBe(false)
    }
  })

  it('omits an empty optional rather than blanking an inherited value', () => {
    const { properties } = buildQuoteCreateBody({ ...base, quoteNumber: undefined, comments: '', sender: { firstname: 'Dean', lastname: '', email: 'dean@example.com', phone: null } })
    expect('hs_quote_number' in properties).toBe(false)
    expect('hs_comments' in properties).toBe(false)
    expect('hs_sender_lastname' in properties).toBe(false)
    expect('hs_sender_phone' in properties).toBe(false)
    expect(properties.hs_sender_firstname).toBe('Dean')
  })

  it('escapes the comments into HTML paragraphs', () => {
    expect(buildQuoteCreateBody({ ...base, comments: 'A & B' }).properties.hs_comments)
      .toBe('<p style="margin:0;">A &amp; B</p>')
  })
})

describe('validateQuoteInput', () => {
  const valid: QuoteCreateInput = {
    title: 'Test - UR', expirationDate: '2026-11-02', dealId: '64568716933', contactId: '12388',
  }

  it('passes a complete input with a cart behind it', () => {
    expect(validateQuoteInput(valid, 1)).toBeNull()
  })

  it('refuses a quote with no contact, naming the fix', () => {
    // A quote is addressed to a person, and HubSpot will not publish without
    // one. Catching it here is what keeps a rejected create from leaving
    // wreckage in the portal.
    expect(validateQuoteInput({ ...valid, contactId: null }, 1)).toBe('Add a contact to the deal before generating a quote.')
  })

  it('refuses a blank title, a bad expiry, no deal and an empty cart', () => {
    expect(validateQuoteInput({ ...valid, title: '  ' }, 1)).toMatch(/title/)
    expect(validateQuoteInput({ ...valid, expirationDate: '2026-13-45' }, 1)).toMatch(/expiry date/)
    expect(validateQuoteInput({ ...valid, dealId: '' }, 1)).toMatch(/not attached to a deal/)
    expect(validateQuoteInput(valid, 0)).toBe('Add at least one line item before generating a quote.')
  })

  it('accepts line item ids in place of a count, for the inline order', () => {
    expect(validateQuoteInput({ ...valid, lineItemIds: ['1'] })).toBeNull()
  })
})
