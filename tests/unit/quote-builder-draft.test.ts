import { describe, it, expect } from 'vitest'
import { PAGE_STATE_MAX_BYTES, pageStateBytes } from '@/lib/page-state'
import {
  isQuoteDraftEmpty,
  parseQuoteBuilderDraft,
  quoteBuilderBase,
  quoteBuilderKey,
  type QuoteBuilderDraft,
} from '@/lib/quote-builder-draft'

const draft = (over: Partial<QuoteBuilderDraft> = {}): QuoteBuilderDraft => ({
  v: 1,
  setupDone: true,
  setup: {
    distributor: 'none',
    depot: 'US-BAL',
    template: 'USA',
    winProbability: '70%',
    repAgent: '',
    isCollection: false,
  },
  lines: [],
  comments: '',
  ...over,
})

describe('the stored draft round trips', () => {
  it('survives a save and a load unchanged', () => {
    const original = draft({
      lines: [
        {
          productId: '1',
          name: 'H9 Panel',
          sku: 'EBH9NA',
          description: 'Green PVC',
          quantity: '12',
          unitPrice: '250',
          discountMode: 'percent',
          discountValue: '10',
        },
      ],
      comments: 'Ships from Baltimore',
    })
    expect(parseQuoteBuilderDraft(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })

  it('keeps a typed unit price, which is a discount the rep expressed differently', () => {
    const original = draft({
      lines: [
        { productId: '1', name: 'H9', quantity: '1', unitPrice: '250', priceDraft: '185' },
      ],
    })
    const parsed = parseQuoteBuilderDraft(JSON.parse(JSON.stringify(original)))
    expect(parsed?.lines[0].priceDraft).toBe('185')
  })

  it('keeps quantities as the strings they were typed as', () => {
    // Turning these into numbers is what produced "0200" in the box; the draft
    // must hand back exactly what was typed.
    const parsed = parseQuoteBuilderDraft(
      draft({ lines: [{ productId: '1', name: 'H9', quantity: '0200', unitPrice: '' }] }),
    )
    expect(parsed?.lines[0].quantity).toBe('0200')
    expect(parsed?.lines[0].unitPrice).toBe('')
  })
})

describe('anything unreadable is treated as no draft', () => {
  it.each([
    ['null', null],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['a future version', { ...draft(), v: 2 }],
    ['a missing setup block', { v: 1, setupDone: true, lines: [], comments: '' }],
    ['a numeric quantity', { ...draft(), lines: [{ productId: '1', name: 'H9', quantity: 3, unitPrice: '1' }] }],
    ['an unknown discount mode', {
      ...draft(),
      lines: [{ productId: '1', name: 'H9', quantity: '1', unitPrice: '1', discountMode: 'freebie' }],
    }],
  ])('refuses %s', (_label, value) => {
    expect(parseQuoteBuilderDraft(value)).toBeNull()
  })

  it('refuses a cart longer than any real quote', () => {
    const lines = Array.from({ length: 121 }, () => ({
      productId: '1',
      name: 'H9',
      quantity: '1',
      unitPrice: '1',
    }))
    expect(parseQuoteBuilderDraft(draft({ lines }))).toBeNull()
    expect(parseQuoteBuilderDraft(draft({ lines: lines.slice(0, 120) }))).not.toBeNull()
  })
})

describe('what counts as worth resuming', () => {
  it('an untouched builder leaves nothing behind', () => {
    expect(isQuoteDraftEmpty(draft({ setupDone: false }))).toBe(true)
  })

  it('answering Quote Setup is itself worth keeping', () => {
    // The whole complaint: the setup answers were nowhere but React state, so
    // every arrival re-asked them.
    expect(isQuoteDraftEmpty(draft({ setupDone: true }))).toBe(false)
  })

  it('a line or a comment is worth keeping even before setup is done', () => {
    expect(
      isQuoteDraftEmpty(
        draft({ setupDone: false, lines: [{ productId: '1', name: 'H9', quantity: '1', unitPrice: '1' }] }),
      ),
    ).toBe(false)
    expect(isQuoteDraftEmpty(draft({ setupDone: false, comments: 'ship from Baltimore' }))).toBe(false)
  })

  it('whitespace is not a comment', () => {
    expect(isQuoteDraftEmpty(draft({ setupDone: false, comments: '   \n ' }))).toBe(true)
  })
})

describe('page keys', () => {
  it('separates a new quote from an edit of a published one', () => {
    expect(quoteBuilderKey('12345')).toBe('quote-builder:12345')
    expect(quoteBuilderKey('12345', 'abc-def')).toBe('quote-builder:12345:edit:abc-def')
    // Mixing them would republish the wrong cart onto a live customer link.
    expect(quoteBuilderKey('12345')).not.toBe(quoteBuilderKey('12345', 'abc-def'))
  })

  it('treats a null edit id as a new quote', () => {
    expect(quoteBuilderKey('12345', null)).toBe('quote-builder:12345')
  })
})

describe('staleness fingerprint', () => {
  const item = (id: string, qty: number, price: number) => ({
    properties: { hs_product_id: id, quantity: qty, price },
  })

  it('ignores the order HubSpot returns line items in', () => {
    expect(quoteBuilderBase([item('1', 2, 10), item('2', 3, 20)])).toBe(
      quoteBuilderBase([item('2', 3, 20), item('1', 2, 10)]),
    )
  })

  it('changes when the deal changes underneath a parked draft', () => {
    const before = quoteBuilderBase([item('1', 2, 10)])
    expect(quoteBuilderBase([item('1', 5, 10)])).not.toBe(before)
    expect(quoteBuilderBase([item('1', 2, 10), item('2', 1, 5)])).not.toBe(before)
  })

  it('separates an edit from a new quote on the same deal', () => {
    expect(quoteBuilderBase([item('1', 2, 10)], 'q1')).not.toBe(quoteBuilderBase([item('1', 2, 10)]))
  })
})

describe('a full cart fits in what the store accepts', () => {
  it('a full cart of 120 long lines stays under the limit', () => {
    // The cap is only meaningful if a cart at the cap can actually be saved.
    // Field lengths here are at the long end of what HubSpot returns.
    const lines = Array.from({ length: 120 }, (_, i) => ({
      productId: `1234567890${i}`,
      name: 'Echo Barrier H9 Acoustic Panel, green PVC front, black back',
      sku: 'EBH9NA-LONG-VARIANT-CODE',
      description:
        'Green PVC front / black back / acoustic absorbent inside. Panels only, substrate by others.',
      quantity: '1200',
      unitPrice: '1234.56',
      discountMode: 'percent' as const,
      discountValue: '12.5',
      priceDraft: '1080.00',
    }))
    const full = draft({ lines, comments: 'x'.repeat(2000) })
    expect(pageStateBytes(full)).toBeLessThan(PAGE_STATE_MAX_BYTES)
  })
})
