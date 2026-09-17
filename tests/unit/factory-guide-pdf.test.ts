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

const M = 16
const W = 210
const H = 297
const CW = W - M * 2

type Page = {
  heading: string
  intro?: string
  shot: string
  /** The numbered badges on that screenshot, in order. */
  steps: Array<[number, string]>
  note?: string
}

const PAGES: Page[] = [
  {
    heading: 'Prihlásenie do Hubu',
    intro: 'Prihlasovacie meno a heslo nájdete v e-maile, ktorý ste dostali spolu s objednávkou. Heslo sa nemení.',
    shot: '01-login',
    steps: [
      [1, 'Zadajte prihlasovacie meno. Je to e-mailová adresa z e-mailu s objednávkou.'],
      [2, 'Zadajte heslo. Pri prvom prihlásení ho uložte v prehliadači, aby ste sa nabudúce prihlásili jedným kliknutím.'],
      [3, 'Stlačte tlačidlo Sign In.'],
    ],
  },
  {
    heading: 'Vaše objednávky',
    intro: 'Po prihlásení sa otvorí karta Výroba. Sú tu všetky objednávky, ktoré sme vám poslali, aj tie už dokončené.',
    shot: '02-orders-list',
    steps: [[1, 'Kliknite na objednávku, ktorú chcete otvoriť.']],
    note: 'Stav objednávky vidíte v poslednom stĺpci: Čaká na vaše potvrdenie, Potvrdená, Vo výrobe alebo Dokončená.',
  },
  {
    heading: 'Krok 1 a 2: stiahnite si objednávku a zadajte termíny',
    shot: '03-steps-before',
    steps: [
      [1, 'Stlačte Stiahnuť objednávku (PDF). Toto je dokument, podľa ktorého vyrábate. Nahradil prílohu, ktorú ste predtým dostávali v e-maile.'],
      [2, 'Zadajte predpokladaný začiatok výroby.'],
      [3, 'Zadajte predpokladané ukončenie výroby.'],
    ],
    note: 'Oba termíny sú povinné. Podľa nich plánujeme prepravu, takže bez nich nemôžeme pokračovať. Kým nie sú vyplnené, tlačidlo Potvrdiť objednávku zostáva neaktívne.',
  },
  {
    heading: 'Krok 2: potvrďte objednávku',
    intro: 'Keď sú oba termíny vyplnené, tlačidlo sa sprístupní.',
    shot: '04-dates-filled',
    steps: [[4, 'Stlačte Potvrdiť objednávku.']],
    note: 'Hneď po potvrdení dostanete potvrdzovací e-mail s vašimi termínmi. Termíny môžete meniť, kým objednávku neoznačíte ako dokončenú.',
  },
  {
    heading: 'Krok 3: výroba dokončená',
    intro: 'Objednávka je potvrdená. Tretí krok sa sprístupní až teraz.',
    shot: '05-confirmed',
    steps: [[5, 'Keď nám pošlete faktúru za túto objednávku, stlačte Výroba dokončená.']],
    note: 'Faktúru môžeme uhradiť až vtedy, keď je jej objednávka tu označená ako dokončená. Takto vieme, že bariéry sú hotové a je možné ich vyzdvihnúť.',
  },
  {
    heading: 'Hotovo',
    intro: 'Objednávka je označená ako dokončená a my o tom vieme. Ďalej už nič robiť netreba.',
    shot: '06-finished',
    steps: [],
    note: 'Ak sa niečo zmení, alebo si nie ste istí, ozvite sa nám. Na objednávku sa môžete kedykoľvek vrátiť.',
  },
]

it.skipIf(!DIR || !OUT)('builds the Slovak guide', async () => {
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
  doc.text('Návod pre výrobu', M, 40)
  set(9.5, 'normal')
  doc.setTextColor(190, 190, 190)
  doc.text('Ako pracovať s objednávkou: stiahnuť, potvrdiť, dokončiť', M, 50)
  doc.setTextColor(0, 0, 0)

  let y = 78
  y = write('Čo sa zmenilo', 13, 'bold', y) + 3
  y = write(
    'Objednávky vám už neposielame ako prílohu e-mailu. Každá objednávka má teraz svoju stránku v Echo Barrier Hube, kde si ju stiahnete, potvrdíte s vašimi termínmi a po fakturácii označíte ako dokončenú. E-mail vás na novú objednávku iba upozorní a odkáže na túto stránku.',
    11, 'normal', y,
  ) + 8

  y = write('Tri kroky pri každej objednávke', 13, 'bold', y) + 4
  const steps: Array<[string, string]> = [
    ['1', 'Stiahnite si objednávku. Je to dokument, podľa ktorého vyrábate.'],
    ['2', 'Potvrďte objednávku. Zadajte predpokladaný začiatok a ukončenie výroby. Oba termíny sú povinné, plánujeme podľa nich prepravu.'],
    ['3', 'Výroba dokončená. Stlačte, keď nám pošlete faktúru za objednávku.'],
  ]
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
  const boxLines = doc.splitTextToSize(
    'Faktúru môžeme uhradiť až vtedy, keď je jej objednávka v Hube označená ako dokončená. Takto vieme, že bariéry sú hotové a je možné ich vyzdvihnúť.',
    CW - 16,
  ) as string[]
  const boxH = boxLines.length * 4.9 + 12
  doc.rect(M, y, CW, boxH, 'F')
  doc.line(M, y, M, y + boxH)
  set(9, 'bold')
  doc.setTextColor(194, 65, 12)
  doc.text('DÔLEŽITÉ', M + 8, y + 7)
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
    doc.text('Echo Barrier Hub. Návod pre výrobu', M, H - 8)
    doc.text(`Strana ${p} z ${pages}`, W - M, H - 8, { align: 'right' })
    doc.setTextColor(0, 0, 0)
  }

  writeFileSync(OUT, Buffer.from(doc.output('arraybuffer') as ArrayBuffer))
  expect(pages).toBe(PAGES.length + 1)
})
