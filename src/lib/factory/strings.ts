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
  colDocuments: string
  docOrder: string
  docPriced: string
  docFailed: string
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
  step1PricedButton: string
  step1PricedHint: string
  step1Files: string
  step1FilesHint: string
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

  // Their own material stock, from the API they gave us
  stockTitle: string
  stockIntro: string
  stockUpdated: string
  stockStale: string
  stockUnchangedSince: string
  stockFrozen: string

  // What they can build against what we will need
  capabilityTitle: string
  capabilityIntro: string
  capabilityRun: string
  capabilityFrozen: string
  colCapability: string
  colCappedBy: string
  colRequirement: string
  capOk: string
  capShort: string
  capUnknown: string
  capProvisional: string
  capNoForecast: string
  emptyCapability: string

  // The per-product breakdown: their materials, their stock, one number of ours
  bdBack: string
  bdIntro: string
  bdRule: string
  bdRuleNoPallet: string
  bdForRequirement: string
  bdForTyped: string
  bdForPallet: string
  bdCeiling: string
  bdCeilingUnknown: string
  bdColPerUnit: string
  bdColPerPallet: string
  bdNotReported: string
  bdBinding: string
  bdNotGating: string
  bdQtyLabel: string
  bdQtyButton: string
  bdUnits: string
  bdNotFound: string
  colNeeded: string
  colShortBy: string
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
  /** Confirmed, but the receipt could not be emailed. They still confirmed. */
  errConfirmEmailFailed: string
  /** Shown in the rail. The factory reads its own language everywhere, sign out included. */
  navSignOut: string
  /** The QR dialog in the header. English on a Slovak screen was the last leak of its kind. */
  phoneOpenLabel: string
  phoneTitle: string
  phoneLead: string
  phoneInstall: string
  phoneCopy: string
  phoneCopied: string
  phoneCopyManual: string
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
  colDocuments: 'Documents',
  docOrder: 'Order',
  docPriced: 'With prices',
  docFailed: 'That document could not be prepared. Open the order and try again.',
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
    'When we sent this order your stock API suggested these might be short. Tell us if that stops you building it.',
  thMaterial: 'Material',
  thNeeded: 'Needed',
  thInStock: 'In stock',
  thShort: 'Short',

  step1Title: 'Download the purchase order',
  step1Body: 'This is purchase order {number}, the document you would have had attached to the email.',
  step1Button: 'Download purchase order (PDF)',
  step1PricedButton: 'Download priced order (PDF)',
  step1PricedHint: 'The priced order is the same order with the agreed prices on it, for your accounts.',
  step1Files: 'Files for this order',
  step1FilesHint: 'Artwork and any other file we attached to this order. Opens in a new tab.',
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
  stockUnchangedSince: 'Unchanged since {date}.',
  stockFrozen:
    'Your stock API has sent us the same figures since {date}. Nothing has moved in that time, which for a working factory means the API has stopped updating. We are raising it with you separately.',
  capabilityTitle: 'What you can build',
  capabilityIntro:
    'For each product: how many you could build from the materials in your stock, and how many we expect to need. Worked out overnight from your stock API and our bill of materials.',
  capabilityRun: 'Calculated {date}.',
  capabilityFrozen:
    'These figures rest on your stock API, which has not changed since {date}. Treat them as out of date until it moves. No low-stock notice will be sent while that is the case.',
  colCapability: 'You can build',
  colCappedBy: 'Limited by',
  colRequirement: 'We will need',
  capOk: 'Enough material',
  capShort: 'Not enough material',
  capUnknown: 'Cannot be calculated',
  capProvisional: 'Estimate: the bill of materials for this product is not confirmed yet.',
  capNoForecast: 'We are not forecasting this product yet.',
  emptyCapability: 'No product can be calculated yet.',

  bdBack: 'Back to stock',
  bdIntro: 'Every material this product uses, against the quantity in your stock API. Your numbers and your bill of materials, nothing else.',
  bdRule: 'Needed = per unit × {qty} + per pallet × {pallets} pallets, at {palletSize} units per pallet. A pallet line counts whole pallets, so one unit over a pallet needs a full set.',
  bdRuleNoPallet: 'Needed = per unit × {qty}. We have no pallet size for this product, so lines charged per pallet are left out rather than guessed.',
  bdForRequirement: 'Worked out for the {qty} units we expect to need.',
  bdForTyped: 'Worked out for {qty} units.',
  bdForPallet: 'We are not forecasting this product yet, so this shows one pallet of {qty} units.',
  bdCeiling: '{material} runs out first. That is what limits you to {max} units.',
  bdCeilingUnknown: 'We cannot work out from your stock API how many of these you can build.',
  bdColPerUnit: 'Per unit',
  bdColPerPallet: 'Per pallet',
  bdNotReported: 'Not in your stock API',
  bdBinding: 'Runs out first',
  bdNotGating: 'This one is not in your stock API, so it never limits the total.',
  bdQtyLabel: 'Work it out for',
  bdQtyButton: 'Calculate',
  bdUnits: 'units',
  bdNotFound: 'We hold no bill of materials for that product.',
  colNeeded: 'Needed',
  colShortBy: 'Short by',
  stockIntro: 'Your material stock, as your stock API last reported it.',
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
  errConfirmEmailFailed:
    'Confirmed, and we have your dates. The confirmation email could not be sent, so keep this page as your record.',
  navSignOut: 'Sign Out',
  phoneOpenLabel: 'Open this page on your phone',
  phoneTitle: 'Open on your phone',
  phoneLead: "Point your phone's camera at the code. The same page opens in your phone's browser.",
  phoneInstall:
    'Sign in the first time. To keep the Hub on your phone: on iPhone, tap Share, then Add to Home Screen. On Android, open the browser menu, then Add to Home screen.',
  phoneCopy: 'Copy link',
  phoneCopied: 'Copied',
  phoneCopyManual: 'Select the link and copy it',
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
  colDocuments: 'Dokumenty',
  docOrder: 'Objednávka',
  docPriced: 'S cenami',
  docFailed: 'Tento dokument sa nepodarilo pripraviť. Otvorte objednávku a skúste to znova.',
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
    'Keď sme vám túto objednávku posielali, vaše skladové API naznačovalo, že týchto materiálov môže byť málo. Dajte nám vedieť, ak vám to bráni vo výrobe.',
  thMaterial: 'Materiál',
  thNeeded: 'Potrebné',
  thInStock: 'Na sklade',
  thShort: 'Chýba',

  step1Title: 'Stiahnite si objednávku',
  step1Button: 'Stiahnuť objednávku (PDF)',
  step1PricedButton: 'Stiahnuť objednávku s cenami (PDF)',
  step1PricedHint: 'Objednávka s cenami je tá istá objednávka s dohodnutými cenami, pre vaše účtovníctvo.',
  step1Files: 'Súbory k tejto objednávke',
  step1FilesHint: 'Grafika a ďalšie súbory, ktoré sme k objednávke pripojili. Otvoria sa v novej karte.',
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
  stockUnchangedSince: 'Bez zmeny od {date}.',
  stockFrozen:
    'Vaše skladové API nám posiela rovnaké údaje od {date}. Odvtedy sa nič nezmenilo, čo pri fungujúcej výrobe znamená, že API sa prestalo aktualizovať. Riešime to s vami samostatne.',
  capabilityTitle: 'Čo dokážete vyrobiť',
  capabilityIntro:
    'Pri každom produkte: koľko kusov by ste dokázali vyrobiť z materiálu na vašom sklade a koľko kusov predpokladáme, že budeme potrebovať. Počíta sa každú noc z vášho skladového API a našich kusovníkov.',
  capabilityRun: 'Vypočítané {date}.',
  capabilityFrozen:
    'Tieto čísla vychádzajú z vášho skladového API, ktoré sa od {date} nezmenilo. Považujte ich za neaktuálne, kým sa neaktualizuje. Upozornenie na nízke zásoby sa dovtedy neodosiela.',
  colCapability: 'Dokážete vyrobiť',
  colCappedBy: 'Obmedzuje',
  colRequirement: 'Budeme potrebovať',
  capOk: 'Dostatok materiálu',
  capShort: 'Nedostatok materiálu',
  capUnknown: 'Nedá sa vypočítať',
  capProvisional: 'Odhad: kusovník tohto produktu ešte nie je potvrdený.',
  capNoForecast: 'Tento produkt zatiaľ neprognózujeme.',
  emptyCapability: 'Zatiaľ nie je možné vypočítať žiadny produkt.',

  bdBack: 'Späť na sklad',
  bdIntro: 'Všetok materiál, ktorý tento produkt spotrebuje, oproti množstvu vo vašom skladovom API. Vaše čísla a váš kusovník, nič iné.',
  bdRule: 'Potrebné = na kus × {qty} + na paletu × {pallets} paliet, pri {palletSize} kusoch na paletu. Paletová položka sa počíta na celé palety, takže jeden kus navyše potrebuje celú sadu.',
  bdRuleNoPallet: 'Potrebné = na kus × {qty}. Pre tento produkt nemáme veľkosť palety, preto položky účtované na paletu vynechávame a neodhadujeme ich.',
  bdForRequirement: 'Prepočítané na {qty} kusov, ktoré predpokladáme, že budeme potrebovať.',
  bdForTyped: 'Prepočítané na {qty} kusov.',
  bdForPallet: 'Tento produkt zatiaľ neprognózujeme, preto je tu jedna paleta, teda {qty} kusov.',
  bdCeiling: 'Najskôr dôjde {material}. To vás obmedzuje na {max} kusov.',
  bdCeilingUnknown: 'Z vášho skladového API sa nedá vypočítať, koľko kusov tohto produktu dokážete vyrobiť.',
  bdColPerUnit: 'Na kus',
  bdColPerPallet: 'Na paletu',
  bdNotReported: 'Nie je vo vašom skladovom API',
  bdBinding: 'Dôjde najskôr',
  bdNotGating: 'Táto položka nie je vo vašom skladovom API, preto nikdy neobmedzuje celkový počet.',
  bdQtyLabel: 'Prepočítať pre',
  bdQtyButton: 'Prepočítať',
  bdUnits: 'kusov',
  bdNotFound: 'Na tento produkt nemáme kusovník.',
  colNeeded: 'Potrebné',
  colShortBy: 'Chýba',
  stockIntro: 'Váš skladový materiál podľa posledných údajov z vášho skladového API.',
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
  errInvalidDates: 'Neplatné termíny. Použite formát 2026-09-30.',
  errConfirmEmailFailed:
    'Potvrdené, vaše termíny máme. Potvrdzovací e-mail sa nepodarilo odoslať, preto si túto stránku ponechajte ako doklad.',
  navSignOut: 'Odhlásiť sa',
  phoneOpenLabel: 'Otvoriť túto stránku v telefóne',
  phoneTitle: 'Otvoriť v telefóne',
  phoneLead: 'Namierte fotoaparát telefónu na kód. V prehliadači telefónu sa otvorí tá istá stránka.',
  phoneInstall:
    'Prvýkrát sa budete musieť prihlásiť. Ak chcete mať Hub v telefóne: na iPhone ťuknite na Share a potom Add to Home Screen. Na Androide otvorte ponuku prehliadača a zvoľte Pridať na plochu.',
  phoneCopy: 'Kopírovať odkaz',
  phoneCopied: 'Skopírované',
  phoneCopyManual: 'Označte odkaz a skopírujte ho',
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
