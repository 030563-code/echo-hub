import { it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerUnicodeFont } from '@/lib/pdf-font'

/**
 * The Slovak guide the factory is given, built from REAL screenshots.
 *
 * Not a test: a generator that skips unless it is told where to read and write, so `npm test` walks
 * past it. Two steps, in order:
 *
 *   NEXT_PUBLIC_HUB_ENV=staging GUIDE_OUT=/tmp/guide \
 *     npx playwright test tests/e2e/factory-guide-capture.spec.ts
 *   GUIDE_OUT=/tmp/guide GUIDE_PDF=/tmp/guide/navod.pdf \
 *     npx vitest run tests/unit/factory-guide-pdf.test.ts
 *
 * 🔴 The capture half MUST run in staging: confirming an order and marking it finished both send
 * mail, and staging is what makes every notifier return early. It refuses to run otherwise.
 *
 * Rebuild both halves whenever the factory screens change, or the guide starts showing a Hub that
 * no longer exists.
 */
const DIR = process.env.GUIDE_OUT ?? ''
const OUT = process.env.GUIDE_PDF ?? ''
/** 'sk' is the factory's own copy. 'en' is the same guide for whoever at Echo Barrier has to
 *  answer a question about it without reading Slovak. */
const LOCALE: 'sk' | 'en' = process.env.GUIDE_LOCALE === 'en' ? 'en' : 'sk'

const M = 16
const W = 210
const H = 297
const CW = W - M * 2

type Page = {
  heading: string
  intro?: string
  /** Null where there is nothing to photograph, such as the browser's own address bar. */
  shot: string | null
  /** The numbered badges on that screenshot, in order. */
  steps: Array<[number, string]>
  note?: string
}

const COPY = {
  sk: {
    title: 'Návod pre výrobu',
    tagline: 'Ako pracovať s objednávkou: stiahnuť, potvrdiť, dokončiť',
    changedTitle: 'Čo sa zmenilo',
    changed:
      'Objednávky vám už neposielame ako prílohu e-mailu. Každá objednávka má teraz svoju stránku v Echo Barrier Hube, kde si ju stiahnete, potvrdíte s vašimi termínmi a po fakturácii označíte ako dokončenú. E-mail vás na novú objednávku iba upozorní a odkáže na túto stránku.',
    threeTitle: 'Tri kroky pri každej objednávke',
    three: [
      'Stiahnite si objednávku. Je to dokument, podľa ktorého vyrábate.',
      'Potvrďte objednávku. Zadajte predpokladaný začiatok a ukončenie výroby. Oba termíny sú povinné, plánujeme podľa nich prepravu.',
      'Výroba dokončená. Stlačte, keď nám pošlete faktúru za objednávku.',
    ],
    importantLabel: 'DÔLEŽITÉ',
    important:
      'Faktúru môžeme uhradiť až vtedy, keď je jej objednávka v Hube označená ako dokončená. Takto vieme, že bariéry sú hotové a je možné ich vyzdvihnúť.',
    footer: 'Echo Barrier Hub. Návod pre výrobu',
    page: (a: number, b: number) => `Strana ${a} z ${b}`,
    pages: [
      { heading: 'Prihlásenie do Hubu',
        intro: 'Prihlasovacie meno a heslo nájdete v e-maile, ktorý ste dostali spolu s objednávkou. Heslo sa nemení.',
        shot: '01-login',
        steps: [
          [1, 'Zadajte prihlasovacie meno. Je to e-mailová adresa z e-mailu s objednávkou.'],
          [2, 'Zadajte heslo. Pri prvom prihlásení ho uložte v prehliadači, aby ste sa nabudúce prihlásili jedným kliknutím.'],
          [3, 'Stlačte tlačidlo Sign In.'],
        ] },
      { heading: 'Vaše objednávky',
        intro: 'Po prihlásení sa otvorí karta Výroba. Sú tu všetky objednávky, ktoré sme vám poslali, aj tie už dokončené.',
        shot: '02-orders-list',
        steps: [[1, 'Kliknite na objednávku, ktorú chcete otvoriť.']],
        note: 'Stav objednávky vidíte v poslednom stĺpci: Čaká na vaše potvrdenie, Potvrdená, Vo výrobe alebo Dokončená.' },
      { heading: 'Krok 1 a 2: stiahnite si objednávku a zadajte termíny',
        shot: '03-steps-before',
        steps: [
          [1, 'Stlačte Stiahnuť objednávku (PDF). Toto je dokument, podľa ktorého vyrábate. Nahradil prílohu, ktorú ste predtým dostávali v e-maile.'],
          [2, 'Zadajte predpokladaný začiatok výroby.'],
          [3, 'Zadajte predpokladané ukončenie výroby.'],
        ],
        note: 'Oba termíny sú povinné. Podľa nich plánujeme prepravu, takže bez nich nemôžeme pokračovať. Kým nie sú vyplnené, tlačidlo Potvrdiť objednávku zostáva neaktívne.' },
      { heading: 'Krok 2: potvrďte objednávku',
        intro: 'Keď sú oba termíny vyplnené, tlačidlo sa sprístupní.',
        shot: '04-dates-filled',
        steps: [[4, 'Stlačte Potvrdiť objednávku.']],
        note: 'Hneď po potvrdení dostanete potvrdzovací e-mail s vašimi termínmi. Termíny môžete meniť, kým objednávku neoznačíte ako dokončenú.' },
      { heading: 'Krok 3: výroba dokončená',
        intro: 'Objednávka je potvrdená. Tretí krok sa sprístupní až teraz.',
        shot: '05-confirmed',
        steps: [[5, 'Keď nám pošlete faktúru za túto objednávku, stlačte Výroba dokončená.']],
        note: 'Faktúru môžeme uhradiť až vtedy, keď je jej objednávka tu označená ako dokončená. Takto vieme, že bariéry sú hotové a je možné ich vyzdvihnúť.' },
      { heading: 'Hotovo',
        intro: 'Objednávka je označená ako dokončená a my o tom vieme. Ďalej už nič robiť netreba.',
        shot: '06-finished', steps: [],
        note: 'Ak sa niečo zmení, alebo si nie ste istí, ozvite sa nám. Na objednávku sa môžete kedykoľvek vrátiť.' },
      { heading: 'Hub ako aplikácia v počítači',
        intro: 'Hub si môžete nainštalovať ako bežnú aplikáciu. Otvorí sa vo vlastnom okne, bez panelov prehliadača, a nájdete ho medzi ostatnými programami. Nič sa nesťahuje ani neaktualizuje: je to okno na hub.echobarrier.com, takže vždy vidíte aktuálnu verziu.',
        shot: '',
        steps: [],
        note: 'Chrome a Edge: vpravo v adresnom riadku sa objaví ikona inštalácie. Kliknite na ňu a potvrďte Inštalovať. Safari na Macu: v ponuke Zdieľať zvoľte Pridať do Docku. Ak ikonu nevidíte, stránku obnovte, objaví sa až po prvom načítaní.' },
      { heading: 'Hub v telefóne',
        intro: 'Tú istú stránku si môžete otvoriť v telefóne bez prepisovania adresy.',
        shot: '07-phone-button',
        steps: [[1, 'Kliknite na ikonu telefónu vpravo hore, vedľa vášho mena.']],
        note: 'Funguje to na ktorejkoľvek stránke: kód vždy vedie na tú, ktorú máte práve otvorenú.' },
      { heading: 'Naskenujte kód',
        intro: 'Namierte fotoaparát telefónu na kód. V prehliadači telefónu sa otvorí tá istá stránka. Prvýkrát sa budete musieť prihlásiť tými istými údajmi.',
        shot: '08-qr',
        steps: [],
        note: 'Ak chcete mať Hub priamo na ploche telefónu: na iPhone ťuknite v Safari na Share a potom Add to Home Screen. Na Androide otvorte ponuku prehliadača a zvoľte Pridať na plochu. iPhone nemá tlačidlo inštalácie vedľa adresy, robí sa to cez Share.' },
    ],
  },
  en: {
    title: 'Manufacturing guide',
    tagline: 'How to work an order: download it, confirm it, finish it',
    changedTitle: 'What changed',
    changed:
      'Purchase orders are no longer attached to an email. Every order now has its own page in the Echo Barrier Hub, where you download it, confirm it with your dates, and mark it finished when you invoice. The email only tells you a new order has arrived and links you to that page.',
    threeTitle: 'Three steps on every order',
    three: [
      'Download the purchase order. It is the document you build from.',
      'Confirm the order. Enter the estimated start and finish of manufacturing. Both dates are required: we plan the transport around them.',
      'Manufacturing finished. Press it when you send us your invoice for the order.',
    ],
    importantLabel: 'IMPORTANT',
    important:
      'We can only pay an invoice once its order is marked finished in the Hub. That is how we know the barriers are done and can be collected.',
    footer: 'Echo Barrier Hub. Manufacturing guide',
    page: (a: number, b: number) => `Page ${a} of ${b}`,
    pages: [
      { heading: 'Signing in',
        intro: 'The username and password are in the email that came with the order. The password does not change.',
        shot: '01-login',
        steps: [
          [1, 'Enter the username. It is the email address from the order email.'],
          [2, 'Enter the password. Save it in your browser the first time, so next time it is one click.'],
          [3, 'Press Sign In.'],
        ] },
      { heading: 'Your orders',
        intro: 'Signing in opens the Manufacturing tab. Every order we have sent you is here, finished ones included.',
        shot: '02-orders-list',
        steps: [[1, 'Click the order you want to open.']],
        note: 'The last column is the status: Awaiting your confirmation, Confirmed, In production or Finished.' },
      { heading: 'Steps 1 and 2: download the order and enter the dates',
        shot: '03-steps-before',
        steps: [
          [1, 'Press Download purchase order (PDF). This is the document you build from. It replaced the attachment you used to get by email.'],
          [2, 'Enter the estimated start of manufacturing.'],
          [3, 'Enter the estimated finish of manufacturing.'],
        ],
        note: 'Both dates are required. We plan the transport around them, so we cannot go ahead without them. Until both are filled in, the Confirm button stays disabled.' },
      { heading: 'Step 2: confirm the order',
        intro: 'Once both dates are filled in the button becomes available.',
        shot: '04-dates-filled',
        steps: [[4, 'Press Confirm purchase order.']],
        note: 'You get a confirmation email with your dates straight away. The dates can still be changed until the order is marked finished.' },
      { heading: 'Step 3: manufacturing finished',
        intro: 'The order is confirmed. Only now does the third step become available.',
        shot: '05-confirmed',
        steps: [[5, 'When you send us your invoice for this order, press Manufacturing finished.']],
        note: 'We can only pay an invoice once its order is marked finished here. That is how we know the barriers are done and can be collected.' },
      { heading: 'Done',
        intro: 'The order is marked finished and we know about it. There is nothing else to do.',
        shot: '06-finished', steps: [],
        note: 'If anything changes, or you are not sure, tell us. You can come back to the order at any time.' },
      { heading: 'The Hub as an app on your computer',
        intro: 'The Hub can be installed like an ordinary application. It opens in its own window with no browser tabs, and sits with your other programs. Nothing is downloaded and nothing needs updating: it is a window onto hub.echobarrier.com, so you always see the current version.',
        shot: '',
        steps: [],
        note: 'Chrome and Edge: an install icon appears at the right-hand end of the address bar. Click it and confirm Install. Safari on a Mac: the Share menu, then Add to Dock. If you cannot see the icon, reload the page: it only appears after the first load.' },
      { heading: 'The Hub on your phone',
        intro: 'You can open the same page on a phone without retyping the address.',
        shot: '07-phone-button',
        steps: [[1, 'Click the phone icon at the top right, next to your name.']],
        note: 'It works on any page: the code always points at the one you have open.' },
      { heading: 'Scan the code',
        intro: 'Point your phone camera at the code and the same page opens in the phone browser. You will have to sign in the first time, with the same details.',
        shot: '08-qr',
        steps: [],
        note: 'To keep the Hub on the phone itself: on iPhone, tap Share in Safari and then Add to Home Screen. On Android, open the browser menu and choose Add to Home screen. iPhone has no install button beside the address bar; it is done through Share.' },
    ],
  },
} as const

const C = COPY[LOCALE]
const PAGES: Page[] = C.pages.map((p) => ({
  heading: p.heading,
  intro: 'intro' in p ? (p.intro as string) : undefined,
  shot: p.shot || null,
  steps: p.steps.map((x) => [x[0], x[1]] as [number, string]),
  note: 'note' in p ? (p.note as string) : undefined,
}))

it.skipIf(!DIR || !OUT)('builds the guide', async () => {
  const { default: jsPDF } = await import('jspdf')
  // 🔴 compress, and MEDIUM on every image. Without both, six full-page screenshots came to 21 MB,
  // which is not a document anybody emails to a factory.
  const doc = new jsPDF({ compress: true })
  const font = registerUnicodeFont(doc)

  const set = (size: number, weight: 'normal' | 'bold' = 'normal') => {
    doc.setFont(font, weight)
    doc.setFontSize(size)
  }
  const write = (text: string, size: number, weight: 'normal' | 'bold', y: number, width = CW) => {
    set(size, weight)
    const lines = doc.splitTextToSize(text, width) as string[]
    doc.text(lines, M, y)
    return y + lines.length * size * 0.42
  }

  // ------------------------------------------------------------------ cover
  doc.setFillColor(17, 17, 17)
  doc.rect(0, 0, W, 62, 'F')
  set(22, 'bold')
  doc.setTextColor(255, 255, 255)
  doc.text('Echo Barrier Hub', M, 28)
  set(15, 'normal')
  doc.setTextColor(255, 112, 38)
  doc.text(C.title, M, 40)
  set(9.5, 'normal')
  doc.setTextColor(190, 190, 190)
  doc.text(C.tagline, M, 50)
  doc.setTextColor(0, 0, 0)

  let y = 78
  y = write(C.changedTitle, 13, 'bold', y) + 3
  y = write(C.changed, 11, 'normal', y) + 8


  y = write(C.threeTitle, 13, 'bold', y) + 4
  const steps: Array<[string, string]> = C.three.map((t, i) => [String(i + 1), t])
  for (const [n, text] of steps) {
    doc.setFillColor(255, 112, 38)
    doc.circle(M + 4, y - 1.6, 4, 'F')
    set(10, 'bold')
    doc.setTextColor(255, 255, 255)
    doc.text(n, M + 4, y + 0.3, { align: 'center' })
    doc.setTextColor(0, 0, 0)
    set(11, 'normal')
    const lines = doc.splitTextToSize(text, CW - 14) as string[]
    doc.text(lines, M + 14, y)
    y += lines.length * 4.7 + 5
  }

  y += 4
  doc.setFillColor(255, 246, 241)
  doc.setDrawColor(255, 112, 38)
  doc.setLineWidth(0.9)
  const boxLines = doc.splitTextToSize(C.important, CW - 16) as string[]

  const boxH = boxLines.length * 4.9 + 12
  doc.rect(M, y, CW, boxH, 'F')
  doc.line(M, y, M, y + boxH)
  set(9, 'bold')
  doc.setTextColor(194, 65, 12)
  doc.text(C.importantLabel, M + 8, y + 7)
  set(11, 'normal')
  doc.setTextColor(0, 0, 0)
  doc.text(boxLines, M + 8, y + 14)

  // ------------------------------------------------------------- the steps
  for (const page of PAGES) {
    doc.addPage()
    let py = 22
    py = write(page.heading, 15, 'bold', py) + 3
    if (page.intro) py = write(page.intro, 10.5, 'normal', py) + 3

    for (const [n, text] of page.steps) {
      doc.setFillColor(255, 112, 38)
      doc.circle(M + 3.4, py - 1.4, 3.4, 'F')
      set(8.5, 'bold')
      doc.setTextColor(255, 255, 255)
      doc.text(String(n), M + 3.4, py + 0.4, { align: 'center' })
      doc.setTextColor(0, 0, 0)
      set(10.5, 'normal')
      const lines = doc.splitTextToSize(text, CW - 12) as string[]
      doc.text(lines, M + 12, py)
      py += lines.length * 4.5 + 3.4
    }

    if (page.note) {
      py += 2
      set(9.5, 'normal')
      doc.setTextColor(120, 60, 0)
      const lines = doc.splitTextToSize(page.note, CW) as string[]
      doc.text(lines, M, py)
      doc.setTextColor(0, 0, 0)
      py += lines.length * 4.1 + 4
    }

    if (!page.shot) continue

    // The screenshot, scaled to whatever height is left.
    const png = readFileSync(`${DIR}/${page.shot}.png`)
    const dims = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) }
    const maxH = H - py - 16
    let w = CW
    let h = (CW * dims.h) / dims.w
    if (h > maxH) {
      h = maxH
      w = (maxH * dims.w) / dims.h
    }
    doc.addImage(
      `data:image/png;base64,${png.toString('base64')}`,
      'PNG', M + (CW - w) / 2, py, w, h, page.shot, 'MEDIUM',
    )
    doc.setDrawColor(220, 220, 220)
    doc.setLineWidth(0.3)
    doc.rect(M + (CW - w) / 2, py, w, h)
  }

  // Page numbers, so nobody works from half a guide.
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p)
    set(8, 'normal')
    doc.setTextColor(150, 150, 150)
    doc.text(C.footer, M, H - 8)
    doc.text(C.page(p, pages), W - M, H - 8, { align: 'right' })
    doc.setTextColor(0, 0, 0)
  }

  writeFileSync(OUT, Buffer.from(doc.output('arraybuffer') as ArrayBuffer))
  expect(pages).toBe(PAGES.length + 1)
  expect(PAGES.length).toBe(9)
})
