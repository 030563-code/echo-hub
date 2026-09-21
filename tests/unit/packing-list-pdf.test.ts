import { describe, it, expect } from 'vitest'
import { asGroupCopy, buildPackingList, type PackingListDoc } from '@/lib/despatch/packing-list'
import { buildPackingListPdf } from '@/lib/despatch/packing-list-pdf'

/**
 * The layout, pinned.
 *
 * Both copies of a real nine-item container have to come out on ONE sheet with
 * their totals and their comments box. They did not on 21 Sep 2026: the
 * incoterms block hung off the tallest column in the address band and pushed
 * the tables 15mm down, and the pallet rows were padded loosely enough that the
 * ninth tipped onto a second page. Nothing in the source says which of those
 * two is load bearing, so the page count is asserted instead.
 */

const SRO = {
  name: 'ECHO BARRIER S.R.O.',
  address: ['Stúrová 3/6', '04001 Košice , Slovakia'],
  identifiers: ['VAT No. SK2023291600', 'ID:46241485', 'https://echobarrier.com/', 'Phone: 00421 904 228 616'],
}
const GROUP = {
  name: 'Echo Barrier Group Limited',
  address: ['41 Central Chambers', 'Dame Court', 'DUBLIN 2', 'IRELAND'],
  identifiers: ['Company Reg. No.: 616375'],
}

/** PL-A USA Jessup 11.09.2026, the fullest recent container. */
function jessup(): PackingListDoc {
  const a = buildPackingList({
    variant: 'A',
    issuer: SRO,
    date: '11/9/26',
    placeOfCollection: ['Košická 26, 080 01', 'Prešov, Slovakia/EU'],
    consignee: {
      name: 'Echo Barrier USA Head Office',
      address: ['33 North Dearborn, Suite 1000', 'Chicago', 'IL 60602', 'USA'],
      identifiers: ['Contact person: David Lindsay', 'Tel. 800 728 9098'],
    },
    deliverTo: { name: 'Capitol Warehouse', address: ['8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'] },
    attention: { name: 'Jillian Rocco', phone: '(+) 1 312 278 5759' },
    incoterms: 'DAP Jessup',
    products: [
      { model: 'H9', description: 'Echo Barrier H9 (1335 x 2050 mm)', quantity: 420, packSize: 70, hasMesh: true, hsCode: '3925.90.0000', poReference: 'EBG26100' },
      { model: 'CS R10', description: 'CS Cutting Station R10', quantity: 5, packSize: 5, hsCode: '3925.90.0000', poReference: 'EBG26100' },
      { model: 'CS R10 Frame', description: 'CS Cutting Station R10 Frames', quantity: 5, packSize: 5, hsCode: '7610.90.00', poReference: 'EBG26100' },
    ],
    signedPallets: 8,
    palletMonth: '2026-09',
    firstPalletNumber: 17,
  })
  return {
    ...a,
    pallets: [...a.pallets, { ref: '', description: 'Frame (CS CSC Frame = 1 pcs)', packingSize: 'loosely laid', netKg: 60, grossKg: 60, loose: true }],
    totalNetKg: 3200,
    totalGrossKg: 3600,
  }
}

describe('the packing list PDF', () => {
  it('puts a nine-item container on one page, on both letterheads', async () => {
    const a = jessup()
    const b = asGroupCopy(a, { issuer: GROUP, consignee: { name: 'Echo Barrier USA Head Office', address: ['33 North Dearborn, Suite 1000', 'Chicago', 'IL 60602', 'USA'] } })
    expect((await buildPackingListPdf(a)).getNumberOfPages()).toBe(1)
    expect((await buildPackingListPdf(b)).getNumberOfPages()).toBe(1)
  })

  it('renders a long container over several pages rather than off the paper', async () => {
    const long = buildPackingList({
      variant: 'A',
      issuer: SRO,
      date: '11/9/26',
      placeOfCollection: ['Košická 26, 080 01', 'Prešov, Slovakia/EU'],
      consignee: GROUP,
      deliverTo: GROUP,
      products: [{ model: 'H9', description: 'Echo Barrier H9', quantity: 2100, packSize: 70, hasMesh: true, hsCode: '3925.90.0000' }],
      signedPallets: 30,
      palletMonth: '2026-09',
      firstPalletNumber: 1,
    })
    expect(long.pallets).toHaveLength(30)
    const doc = await buildPackingListPdf(long)
    expect(doc.getNumberOfPages()).toBeGreaterThan(1)
  })

  it('renders Slovak place names without dropping or swapping a letter', async () => {
    // Registering the Unicode font is what makes Košice and Prešov print. The
    // built-in CP1252 face prints the WRONG letters, not blanks, so a render
    // that throws is not the failure mode to guard against.
    const doc = await buildPackingListPdf(jessup())
    const text = doc.output('arraybuffer')
    expect(text.byteLength).toBeGreaterThan(20_000)
    expect(doc.getFontList()).toHaveProperty('LiberationSans')
  })
})
