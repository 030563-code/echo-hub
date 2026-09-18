import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FACTORY_LOCALE,
  FACTORY_DATE_LOCALE,
  FACTORY_LOCALES,
  FACTORY_LOCALE_COOKIE,
  FACTORY_STRINGS,
  factoryDate,
  fill,
  isFactoryLocale,
  strings,
} from '@/lib/factory/strings'

/**
 * The manufacturer's screens are in Slovak.
 *
 * Dean, 16 Sep 2026: "on the hub itself there should be a slovak translation in
 * the manufacturing side." The compiler already refuses a language missing a
 * key, because FactoryStrings has them all required. What it cannot see is an
 * English sentence pasted into the Slovak table, or an English sentence left
 * behind in a page, and those are what this pins.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

const factoryFiles = (): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(entry)) out.push(rel)
    }
  }
  walk('src/app/(dashboard)/factory')
  return out
}

describe('the two languages are complete and actually different', () => {
  it('is Slovak unless somebody asks otherwise', () => {
    expect(DEFAULT_FACTORY_LOCALE).toBe('sk')
    expect(FACTORY_LOCALES).toEqual(['sk', 'en'])
    expect(isFactoryLocale('sk')).toBe(true)
    expect(isFactoryLocale('SK')).toBe(false)
    expect(isFactoryLocale('de')).toBe(false)
    expect(isFactoryLocale(null)).toBe(false)
  })

  it('carries the same keys in both, with nothing blank', () => {
    const sk = Object.keys(FACTORY_STRINGS.sk).sort()
    const en = Object.keys(FACTORY_STRINGS.en).sort()
    expect(sk).toEqual(en)
    expect(sk.length).toBeGreaterThan(50)
    for (const locale of FACTORY_LOCALES) {
      for (const [key, value] of Object.entries(FACTORY_STRINGS[locale])) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('')
      }
    }
  })

  it('has no English left in the Slovak table', () => {
    // Every single string differs between the two. An identical pair is the
    // signature of a key added to one language and copied into the other.
    for (const key of Object.keys(FACTORY_STRINGS.en) as (keyof typeof FACTORY_STRINGS.en)[]) {
      expect(FACTORY_STRINGS.sk[key], `${String(key)} is the same in both languages`).not.toBe(
        FACTORY_STRINGS.en[key]
      )
    }
  })

  it('keeps every {placeholder} on both sides, so neither loses a value', () => {
    const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const key of Object.keys(FACTORY_STRINGS.en) as (keyof typeof FACTORY_STRINGS.en)[]) {
      expect(holes(FACTORY_STRINGS.sk[key]), String(key)).toEqual(holes(FACTORY_STRINGS.en[key]))
    }
  })

  it('translates the words the manufacturer acts on', () => {
    const sk = strings('sk')
    expect(sk.navManufacturing).toBe('Výroba')
    expect(sk.navStock).toBe('Sklad')
    expect(sk.confirmOrder).toBe('Potvrdiť objednávku')
    expect(sk.step3Button).toBe('Výroba dokončená')
    expect(sk.step1Button).toBe('Stiahnuť objednávku (PDF)')
    expect(sk.step1PricedButton).toBe('Stiahnuť objednávku s cenami (PDF)')
    // The same two documents, shortened for the row on the order list.
    expect(sk.docOrder).toBe('Objednávka')
    expect(sk.docPriced).toBe('S cenami')
    expect(strings('en').confirmOrder).toBe('Confirm purchase order')
  })
})

describe('fill and factoryDate', () => {
  it('substitutes what it is given and leaves the rest alone', () => {
    expect(fill('Objednávka {number}', { number: 'EBSRO8001-1' })).toBe('Objednávka EBSRO8001-1')
    expect(fill('a ďalšie ({count})', { count: 2 })).toBe('a ďalšie (2)')
    // An unknown placeholder stays visible rather than becoming "undefined".
    expect(fill('Hello {missing}', {})).toBe('Hello {missing}')
  })

  it('formats dates in the language the reader chose', () => {
    expect(FACTORY_DATE_LOCALE.sk).toBe('sk-SK')
    expect(FACTORY_DATE_LOCALE.en).toBe('en-GB')
    const sk = factoryDate('2026-09-16T00:00:00Z', 'sk', { day: 'numeric', month: 'long', year: 'numeric' })
    const en = factoryDate('2026-09-16T00:00:00Z', 'en', { day: 'numeric', month: 'long', year: 'numeric' })
    expect(sk).not.toBe('')
    expect(sk).not.toBe(en)
    expect(en).toContain('September')
  })

  it('gives an empty string for nothing and for nonsense, never Invalid Date', () => {
    expect(factoryDate(null, 'sk')).toBe('')
    expect(factoryDate(undefined, 'en')).toBe('')
    expect(factoryDate('not a date', 'sk')).toBe('')
  })
})

describe('the pages say nothing in English of their own', () => {
  const files = factoryFiles()

  it('covers the whole factory folder', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  it('has no retired English sentence left anywhere in it', () => {
    // The literals that used to be hard-coded. If one comes back it is a page
    // that stopped going through the table.
    const retired = [
      'Awaiting your confirmation',
      'Purchase orders sent to you',
      'Download purchase order (PDF)',
      'Confirm the purchase order',
      'Your material stock',
      'No orders yet',
      'Not yet',
      'Save dates',
      'Sent to you on',
      'Materials your system showed as low',
    ]
    for (const file of files) {
      const source = read(file)
      for (const phrase of retired) {
        expect(source.includes(phrase), `${file} still says "${phrase}"`).toBe(false)
      }
    }
  })

  it('switches language through a route handler, not a client toggle', () => {
    const route = read('src/app/factory-lang/[locale]/route.ts')
    expect(route).toContain('isFactoryLocale(wanted)')
    expect(route).toContain('FACTORY_LOCALE_COOKIE')
    expect(route).toContain('httpOnly: true')
    // safeNextPath, so ?next= can only ever be a path on this site.
    expect(route).toContain("safeNextPath(url.searchParams.get('next'))")
    expect(FACTORY_LOCALE_COOKIE).toBe('factory_lang')
  })

  it('resolves the language on the server, falling back to Slovak', () => {
    const server = read('src/lib/factory/locale.server.ts')
    expect(server).toContain("import 'server-only'")
    expect(server).toContain('isFactoryLocale(value) ? value : DEFAULT_FACTORY_LOCALE')
  })
})
