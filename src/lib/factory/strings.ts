/**
 * The manufacturer's screens, in their language.
 *
 * Dean, 16 Sep 2026: "The email to manufacturing should be in slovak not
 * english then on the hub itself there should be a slovak translation in the
 * manufacturing side."
 *
 * So Slovak is the DEFAULT here, not the alternative: the people who use these
 * pages every day work in Slovak, and the English is for us when we look over
 * their shoulder. The switch is two links in the factory tab bar and the choice
 * lives in a cookie, so it survives a sign-out and a new device is simply Slovak
 * again.
 *
 * Pure on purpose: no cookies, no database, no server-only import. A server
 * component resolves the locale (locale.server.ts) and passes it down; a client
 * component imports this module directly and reads the same table, so nothing
 * has to be serialised across the boundary except the two-letter code.
 *
 * Every string is a plain string with {placeholders}, never a function, for the
 * same reason: functions do not cross that boundary. `fill` does the
 * substitution on whichever side needs it.
 *
 * FactoryStrings has every key required, so a language cannot quietly lose one:
 * the compiler refuses the object before the test does.
 */

export const FACTORY_LOCALES = ['sk', 'en'] as const

export type FactoryLocale = (typeof FACTORY_LOCALES)[number]

/** Slovak unless somebody has asked for English. */
export const DEFAULT_FACTORY_LOCALE: FactoryLocale = 'sk'

export const FACTORY_LOCALE_COOKIE = 'factory_lang'

/** A year: a preference, not a session. */
export const FACTORY_LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function isFactoryLocale(value: unknown): value is FactoryLocale {
  return typeof value === 'string' && (FACTORY_LOCALES as readonly string[]).includes(value)
}

/** What each language calls itself, for the switch. */
export const FACTORY_LOCALE_NAMES: Record<FactoryLocale, string> = {
  sk: 'Slovensky',
  en: 'English',
}

/**
 * The BCP 47 tag for dates and numbers. Slovak writes 16. septembra 2026 and
 * 16. 9. 2026, which Intl already knows; hard-coding en-GB printed a Slovak
 * factory's dates in English month names.
 */
export const FACTORY_DATE_LOCALE: Record<FactoryLocale, string> = {
  sk: 'sk-SK',
  en: 'en-GB',
}

export interface FactoryStrings {
  // The tab bar
  navManufacturing: string
  navStock: string
  language: string

  // The order list
  ordersTitle: string
  ordersIntro: string
  colPurchaseOrder: string
  colProducts: string
  colUnits: string
  colSentToYou: string
  colStart: string
  colFinish: string
  colStatus: string
  noLines: string
  andMore: string
  searchOrders: string
  emptyOrders: string

  // Where an order stands
  statusAwaitingConfirmation: string
  statusConfirmed: string
  statusInProduction: string
  statusFinished: string

  // One order
  backToOrders: string
  orderTitle: string
  sentOn: string
  thProduct: string
  thQuantity: string
  orderHasNoLines: string
  shortagesTitle: string
  shortagesIntro: string
  thMaterial: string
  thNeeded: string
  thInStock: string
  thShort: string

  // The three steps
  step1Title: string
  step1Body: string
  step1Button: string
  step2Title: string
  step2Confirmed: string
  step2StillEditable: string
  step2Body: string
  labelEstimatedStart: string
  labelEstimatedFinish: string
  required: string
  saveDates: string
  saving: string
  confirmOrder: string
  confirming: string
  bothDatesHint: string
  datesSaved: string
  step3Title: string
  step3Done: string
  step3BodyLead: string
  step3BodyStrong: string
  step3BodyTail: string
  step3ConfirmFirst: string
  step3Button: string
  step3AreYouSure: string
  step3Yes: string
  step3No: string

  // Their own material feed
  stockTitle: string
  stockIntro: string
  stockUpdated: string
  stockStale: string
  colCode: string
  colItem: string
  colQuantity: string
  colUnit: string
  colUpdated: string
  searchStock: string
  emptyStock: string
  availabilityInStock: string
  availabilitySoldOut: string
  availabilityLastPieces: string

  // What the server says when it refuses
  errFinishBeforeStart: string
  errDatesNotSaved: string
  errAlreadyFinishedDates: string
  errBothDatesRequired: string
  errConfirmationNotSaved: string
  errAlreadyConfirmed: string
  errNotSaved: string
  errConfirmFirst: string
  errAlreadyFinished: string
  errOrderNotYours: string
  errInvalidDates: string
  errInvalidOrder: string
  errNoDocument: string
}

const en: FactoryStrings = {
  navManufacturing: 'Manufacturing',
  navStock: 'Stock',
  language: 'Language',

  ordersTitle: 'Manufacturing',
  ordersIntro:
    'Purchase orders sent to you. Open one to download it, confirm it with your dates, and mark it finished when you invoice.',
  colPurchaseOrder: 'Purchase order',
  colProducts: 'Products',
  colUnits: 'Units',
  colSentToYou: 'Sent to you',
  colStart: 'Start',
  colFinish: 'Finish',
  colStatus: 'Status',
  noLines: 'No lines',
  andMore: 'and {count} more',
  searchOrders: 'Search by order number or product…',
  emptyOrders: 'No orders yet. An order appears here the moment it is sent to you.',

  statusAwaitingConfirmation: 'Awaiting your confirmation',
  statusConfirmed: 'Confirmed',
  statusInProduction: 'In production',
  statusFinished: 'Finished',

  backToOrders: 'All orders',
  orderTitle: 'Purchase order {number}',
  sentOn: 'Sent to you on {date}.',
  thProduct: 'Product',
  thQuantity: 'Quantity',
  orderHasNoLines: 'This order has no lines.',
  shortagesTitle: 'Materials your system showed as low',
  shortagesIntro:
    'When we sent this order your stock feed suggested these might be short. Tell us if that stops you building it.',
  thMaterial: 'Material',
  thNeeded: 'Needed',
  thInStock: 'In stock',
  thShort: 'Short',

  step1Title: 'Download the purchase order',
  step1Body: 'This is purchase order {number}, the document you would have had attached to the email.',
  step1Button: 'Download purchase order (PDF)',
  step2Title: 'Confirm the purchase order',
  step2Confirmed: 'Confirmed on {date}. We have your dates and a confirmation email is on its way to you.',
  step2StillEditable: 'You can still change these dates until the order is finished.',
  step2Body:
    'Tell us when you expect to start and finish. We need both dates: they are what we plan the shipping around, and they are quoted back to you in the confirmation email.',
  labelEstimatedStart: 'Estimated start',
  labelEstimatedFinish: 'Estimated finish',
  required: '(required)',
  saveDates: 'Save dates',
  saving: 'Saving...',
  confirmOrder: 'Confirm purchase order',
  confirming: 'Confirming...',
  bothDatesHint: 'Fill in both dates and the button turns on.',
  datesSaved: 'Saved. Thank you.',
  step3Title: 'Manufacturing finished',
  step3Done:
    'You marked this order finished on {date}. Echo Barrier have been told, and the barriers can be collected.',
  step3BodyLead: 'Press this when you send us your invoice for this order. ',
  step3BodyStrong: 'We can only pay an invoice once its order is marked finished here',
  step3BodyTail: ', because this is how we know the barriers exist and can be collected.',
  step3ConfirmFirst: 'Confirm the purchase order first, with your estimated dates.',
  step3Button: 'Manufacturing finished',
  step3AreYouSure: 'Are the barriers on this order finished and ready to collect? This cannot be undone.',
  step3Yes: 'Yes, it is finished',
  step3No: 'Not yet',

  stockTitle: 'Stock',
  stockIntro: 'Your material stock, as your system last reported it.',
  stockUpdated: 'Updated {date}.',
  stockStale:
    'These figures are more than a day old. The overnight update has not run since, so treat them as out of date.',
  colCode: 'Code',
  colItem: 'Item',
  colQuantity: 'Quantity',
  colUnit: 'Unit',
  colUpdated: 'Updated',
  searchStock: 'Search by code or item…',
  emptyStock: 'No stock has come through from your system yet.',
  availabilityInStock: 'In stock',
  availabilitySoldOut: 'Sold out',
  availabilityLastPieces: 'Last pieces',

  errFinishBeforeStart: 'The finish date cannot be before the start date.',
  errDatesNotSaved: 'The dates could not be saved. Please try again.',
  errAlreadyFinishedDates: 'This order is already marked finished, so its dates can no longer change.',
  errBothDatesRequired: 'Enter the estimated start and finish dates to confirm.',
  errConfirmationNotSaved: 'The confirmation could not be saved. Please try again.',
  errAlreadyConfirmed: 'This order has already been confirmed.',
  errNotSaved: 'That could not be saved. Please try again.',
  errConfirmFirst: 'Confirm the purchase order first, with your estimated dates.',
  errAlreadyFinished: 'This order is already marked finished.',
  errOrderNotYours: 'This order is not available.',
  errInvalidDates: 'Invalid dates',
  errInvalidOrder: 'Invalid order',
  errNoDocument: 'The document for this order is not available. Please contact Echo Barrier.',
}

const sk: FactoryStrings = {
  navManufacturing: 'Výroba',
  navStock: 'Sklad',
  language: 'Jazyk',

  ordersTitle: 'Výroba',
  ordersIntro:
    'Objednávky, ktoré sme vám poslali. Otvorte objednávku, stiahnite si ju, potvrďte ju s vašimi termínmi a po vystavení faktúry ju označte ako dokončenú.',
  colPurchaseOrder: 'Objednávka',
  colProducts: 'Produkty',
  colUnits: 'Kusy',
  colSentToYou: 'Odoslané vám',
  colStart: 'Začiatok',
  colFinish: 'Ukončenie',
  colStatus: 'Stav',
  noLines: 'Žiadne položky',
  andMore: 'a ďalšie ({count})',
  searchOrders: 'Hľadať podľa čísla objednávky alebo produktu…',
  emptyOrders: 'Zatiaľ žiadne objednávky. Objednávka sa tu zobrazí hneď, ako vám ju pošleme.',

  statusAwaitingConfirmation: 'Čaká na vaše potvrdenie',
  statusConfirmed: 'Potvrdená',
  statusInProduction: 'Vo výrobe',
  statusFinished: 'Dokončená',

  backToOrders: 'Všetky objednávky',
  orderTitle: 'Objednávka {number}',
  sentOn: 'Odoslané vám {date}.',
  thProduct: 'Produkt',
  thQuantity: 'Množstvo',
  orderHasNoLines: 'Táto objednávka nemá žiadne položky.',
  shortagesTitle: 'Materiály, ktoré váš systém ukázal ako nedostatkové',
  shortagesIntro:
    'Keď sme vám túto objednávku posielali, váš sklad naznačoval, že týchto materiálov môže byť málo. Dajte nám vedieť, ak vám to bráni vo výrobe.',
  thMaterial: 'Materiál',
  thNeeded: 'Potrebné',
  thInStock: 'Na sklade',
  thShort: 'Chýba',

  step1Title: 'Stiahnite si objednávku',
  step1Button: 'Stiahnuť objednávku (PDF)',
  step1Body: 'Toto je objednávka {number}, dokument, ktorý ste predtým dostávali v prílohe e-mailu.',
  step2Title: 'Potvrďte objednávku',
  step2Confirmed: 'Potvrdené {date}. Máme vaše termíny a potvrdzovací e-mail je na ceste k vám.',
  step2StillEditable: 'Tieto termíny môžete meniť, kým nie je objednávka dokončená.',
  step2Body:
    'Dajte nám vedieť, kedy predpokladáte začiatok a ukončenie výroby. Potrebujeme oba termíny: podľa nich plánujeme prepravu a uvedieme ich v potvrdzovacom e-maile.',
  labelEstimatedStart: 'Predpokladaný začiatok',
  labelEstimatedFinish: 'Predpokladané ukončenie',
  required: '(povinné)',
  saveDates: 'Uložiť termíny',
  saving: 'Ukladá sa...',
  confirmOrder: 'Potvrdiť objednávku',
  confirming: 'Potvrdzuje sa...',
  bothDatesHint: 'Vyplňte oba termíny a tlačidlo sa sprístupní.',
  datesSaved: 'Uložené. Ďakujeme.',
  step3Title: 'Výroba dokončená',
  step3Done:
    'Túto objednávku ste označili ako dokončenú {date}. Echo Barrier o tom vie a bariéry je možné vyzdvihnúť.',
  step3BodyLead: 'Stlačte toto tlačidlo, keď nám pošlete faktúru za túto objednávku. ',
  step3BodyStrong: 'Faktúru môžeme uhradiť až vtedy, keď je jej objednávka tu označená ako dokončená',
  step3BodyTail: ', pretože takto vieme, že bariéry sú hotové a je možné ich vyzdvihnúť.',
  step3ConfirmFirst: 'Najprv potvrďte objednávku a zadajte predpokladané termíny.',
  step3Button: 'Výroba dokončená',
  step3AreYouSure: 'Sú bariéry z tejto objednávky hotové a pripravené na vyzdvihnutie? Túto akciu nie je možné vrátiť späť.',
  step3Yes: 'Áno, je dokončená',
  step3No: 'Ešte nie',

  stockTitle: 'Sklad',
  stockIntro: 'Váš skladový materiál podľa posledných údajov z vášho systému.',
  stockUpdated: 'Aktualizované {date}.',
  stockStale:
    'Tieto údaje sú staršie ako jeden deň. Nočná aktualizácia odvtedy neprebehla, preto ich považujte za neaktuálne.',
  colCode: 'Kód',
  colItem: 'Položka',
  colQuantity: 'Množstvo',
  colUnit: 'Jednotka',
  colUpdated: 'Aktualizované',
  searchStock: 'Hľadať podľa kódu alebo položky…',
  emptyStock: 'Z vášho systému zatiaľ neprišli žiadne skladové údaje.',
  availabilityInStock: 'Skladom',
  availabilitySoldOut: 'Vypredané',
  availabilityLastPieces: 'Posledné kusy',

  errFinishBeforeStart: 'Dátum ukončenia nemôže byť skorší ako dátum začiatku.',
  errDatesNotSaved: 'Termíny sa nepodarilo uložiť. Skúste to prosím znova.',
  errAlreadyFinishedDates: 'Táto objednávka je už označená ako dokončená, jej termíny sa už nedajú zmeniť.',
  errBothDatesRequired: 'Na potvrdenie zadajte predpokladaný začiatok aj ukončenie.',
  errConfirmationNotSaved: 'Potvrdenie sa nepodarilo uložiť. Skúste to prosím znova.',
  errAlreadyConfirmed: 'Táto objednávka už bola potvrdená.',
  errNotSaved: 'Nepodarilo sa to uložiť. Skúste to prosím znova.',
  errConfirmFirst: 'Najprv potvrďte objednávku a zadajte predpokladané termíny.',
  errAlreadyFinished: 'Táto objednávka je už označená ako dokončená.',
  errOrderNotYours: 'Táto objednávka nie je dostupná.',
  errInvalidDates: 'Neplatné termíny',
  errInvalidOrder: 'Neplatná objednávka',
  errNoDocument: 'Dokument k tejto objednávke nie je dostupný. Kontaktujte prosím Echo Barrier.',
}

export const FACTORY_STRINGS: Record<FactoryLocale, FactoryStrings> = { sk, en }

export function strings(locale: FactoryLocale): FactoryStrings {
  return FACTORY_STRINGS[locale]
}

/**
 * Substitute {name} placeholders.
 *
 * Deliberately dumb: no formatting, no pluralisation, no nesting. Everything
 * that needs a language-aware format (a date, a number) is formatted by the
 * caller with FACTORY_DATE_LOCALE and arrives here as a finished string.
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  )
}

/** A date in the manufacturer's language. Empty for a missing one. */
export function factoryDate(
  value: string | null | undefined,
  locale: FactoryLocale,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
): string {
  if (!value) return ''
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(FACTORY_DATE_LOCALE[locale], options)
}
