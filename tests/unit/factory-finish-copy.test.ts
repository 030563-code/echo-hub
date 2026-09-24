import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FACTORY_LOCALES, FACTORY_STRINGS, strings } from '@/lib/factory/strings'

/**
 * Manufacturing finished is not a payment gate, and nothing the factory reads may say it is.
 *
 * Until 24 Sep 2026 the order page, the orders list and the guide told the factory we could only
 * pay their invoice once the order was marked finished in the Hub. Nothing in the Hub, Supabase
 * or n8n reads finished_at before a supplier invoice is paid, and the factory said so. Telling a
 * supplier something untrue to get a button pressed costs more than the button is worth.
 *
 * What the button does (finishManufacturingOrder): records the order as manufactured, moves it to
 * ready for shipment, puts the barriers into stock and tells our team. For the factory that comes
 * down to one instruction: press it when the whole order is manufactured and packed, so we can
 * arrange the collection.
 */

/** Paying, and invoicing, in either language. */
const PAYMENT = /\b(pay|pays|paid|paying|payment|invoic\w*)\b|faktúr|faktur|uhrad|zaplat|platb/i

describe('the factory screens say what the finished button does, and nothing about payment', () => {
  it('no string on the factory screens, in either language, mentions paying or invoicing', () => {
    for (const locale of FACTORY_LOCALES) {
      for (const [key, value] of Object.entries(FACTORY_STRINGS[locale])) {
        expect(value, `${locale}.${key}`).not.toMatch(PAYMENT)
      }
    }
  })

  it('the finished card says to press it once the whole order is manufactured and packed', () => {
    const card = (locale: 'sk' | 'en') => {
      const t = strings(locale)
      return t.step3BodyLead + t.step3BodyStrong + t.step3BodyTail
    }
    expect(card('en')).toBe('Press this when the whole order is manufactured and packed, so we can arrange the collection.')
    expect(card('sk')).toBe(
      'Stlačte toto tlačidlo, keď je celá objednávka vyrobená a zabalená, aby sme mohli zorganizovať jej vyzdvihnutie.',
    )
  })

  it('the orders list names the button by its own label', () => {
    for (const locale of FACTORY_LOCALES) {
      const t = strings(locale)
      expect(t.ordersIntro, locale).toContain(t.step3Button)
    }
  })
})

describe('the guide says the same, in both languages', () => {
  // The generator is where the guide's words live; the PDFs are built from it.
  const source = readFileSync(join(process.cwd(), 'tests/unit/factory-guide-pdf.test.ts'), 'utf8')
  const copy = source.slice(source.indexOf('const COPY = {'), source.indexOf('} as const'))

  it('mentions neither paying nor invoicing', () => {
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).not.toMatch(PAYMENT)
  })

  it('tells them when to press Manufacturing finished', () => {
    expect(copy).toContain('Keď je celá objednávka vyrobená a zabalená, stlačte Výroba dokončená.')
    expect(copy).toContain('When the whole order is manufactured and packed, press Manufacturing finished.')
  })
})
