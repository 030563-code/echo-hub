import { EB_GREEN, drawBrandHeader } from "@/lib/pdf-brand";
import { displayPoNumber } from "@/lib/po-number";
import { entityPoCurrency, convertCurrency, CURRENCY_SYMBOL, type Currency, type FxRates } from "@/lib/po-currency";
import type { PurchaseOrder } from "@/lib/erp-types";

/** A resolved From/To party — legal name + address lines. */
export interface PdfParty {
  name: string;
  lines: string[];
}

export interface PoPdfOptions {
  canViewCost: boolean;
  /** entity/depot/supplier code → resolved name + address (built server-side). */
  parties: Record<string, PdfParty>;
  /** Weekly EUR-pivot FX rates, or null when unavailable (then no conversion). */
  fx: FxRates | null;
  /** Currency the stored unit_price is denominated in (the root depot's). */
  rootCurrency: Currency;
  /**
   * The wordmark, for a server-side render. The browser leaves this out and the
   * header fetches it; the server has no origin to fetch from and reads it off
   * disk instead.
   */
  logoDataUrl?: string;
}

// jsPDF's built-in Helvetica is WinAnsi (CP1252). Slovak/Czech carons outside
// CP1252 (č ť ľ ď ň ĺ ŕ ě ř ů) make it emit the whole line as UTF-16 garbage, so
// transliterate just those; CP1252 accents (á š ž é í ó ú ä ö) render fine. Also
// swaps the arrow, which Helvetica can't draw either.
const NON_CP1252: Record<string, string> = {
  č: "c", Č: "C", ť: "t", Ť: "T", ľ: "l", Ľ: "L", ď: "d", Ď: "D", ň: "n", Ň: "N",
  ĺ: "l", Ĺ: "L", ŕ: "r", Ŕ: "R", ě: "e", Ě: "E", ř: "r", Ř: "R", ů: "u", Ů: "U",
};
function pdfText(s: string | null | undefined): string {
  return (s ?? "").replace(/[čČťŤľĽďĎňŇĺĹŕŔěĚřŘůŮ]/g, (ch) => NON_CP1252[ch] ?? ch).replace(/→/g, "->");
}

const party = (opts: PoPdfOptions, code: string): PdfParty =>
  opts.parties[code] ?? { name: code, lines: [] };

/** The internal number, not the display value, which may read "Awaiting...". */
export function poPdfFilename(po: PurchaseOrder): string {
  return `${po.po_number.replace(/\s+/g, "")}.pdf`;
}

// Generates a branded PURCHASE ORDER PDF from a PO row on the board. Prices are
// shown only for cost.view holders, in THIS leg's currency (converted from the
// entered root-depot currency).
//
// PURE, and returns the document rather than saving it, since 16 Sep 2026: the
// same bytes now have to be attached to the Xero purchase order, and bytes that
// exist only inside a click handler in somebody's browser cannot be attached to
// anything. Exactly the move bamida-po-pdf.ts made for the same reason. jsPDF is
// imported dynamically so it stays out of the bundle until something renders,
// which is what lets this run on the server and in the browser and produce the
// same document either way.
export async function buildPoPdf(po: PurchaseOrder, opts: PoPdfOptions) {
  const { default: jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const d = new jsPDF();
  const W = d.internal.pageSize.width;
  const priced = opts.canViewCost;

  const legCcy = entityPoCurrency(po.from_entity);
  const sym = CURRENCY_SYMBOL[legCcy];
  const conv = (v: number) => convertCurrency(v, opts.rootCurrency, legCcy, opts.fx);

  // Header — the PO number and the date, and nothing else.
  //
  // Dean, 9 Sep 2026: this document goes outside the company, so it carries no
  // internal chain reference, no approver, no status and no SKU. Everything a
  // reader needs is the order itself; everything else was us talking to
  // ourselves on a page somebody else reads.
  const partyY = await drawBrandHeader(d, W, {
    title: "PURCHASE ORDER",
    refs: [
      `PO Number: ${pdfText(displayPoNumber(po.po_number))}`,
      `Date: ${(po.created_at ?? "").slice(0, 10)}`,
    ],
    logoDataUrl: opts.logoDataUrl,
  });

  // From / To — full addresses, no "(buyer)"/"(supplier)" labels.
  const from = party(opts, po.from_entity);
  const to = party(opts, po.to_entity);
  const colR = W / 2 + 6;
  d.setFontSize(9);
  d.setFont("helvetica", "bold");
  d.text("From", 14, partyY);
  d.text("To", colR, partyY);
  d.setFont("helvetica", "normal");
  d.text([from.name, ...from.lines].map(pdfText), 14, partyY + 5);
  d.text([to.name, ...to.lines].map(pdfText), colR, partyY + 5);

  // Meta — the delivery address, which is the only line here a recipient acts on.
  const metaY = partyY + 5 + Math.max(from.lines.length, to.lines.length) * 4 + 10;
  const meta = po.delivery_address ? [`Deliver to: ${po.delivery_address}`] : [];
  if (meta.length) d.text(meta.map(pdfText), 14, metaY);

  const lines = po.lines ?? [];
  let total = 0;
  const head = priced
    ? [["Ln", "Description", "Qty", "HS code", `Unit price (${legCcy})`, `Line total (${legCcy})`]]
    : [["Ln", "Description", "Qty", "HS code"]];
  const body = lines.map((l, i) => {
    const base = [String(i + 1), pdfText(l.product_name ?? l.sku), String(l.quantity), l.hs_code ?? "—"];
    if (!priced) return base;
    // Round the converted unit FIRST, then derive the line total, so unit×qty is
    // internally consistent (and everything shows exactly 2dp).
    const up = Math.round(conv(l.unit_price ?? 0) * 100) / 100;
    const lt = up * l.quantity;
    total += lt;
    return [...base, up.toFixed(2), lt.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })];
  });

  autoTable(d, {
    startY: metaY + 14,
    head,
    body,
    styles: { fontSize: 9 },
    headStyles: { fillColor: EB_GREEN, textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: priced ? { 4: { halign: "right" }, 5: { halign: "right" } } : {},
  });

  let y = ((d as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 120) + 8;
  if (priced) {
    d.setFont("helvetica", "bold");
    d.setFontSize(10);
    d.setTextColor(EB_GREEN[0], EB_GREEN[1], EB_GREEN[2]);
    d.text(`TOTAL (${legCcy})   ${sym}${total.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
    d.setTextColor(0, 0, 0);
    y += 6;
    if (legCcy !== opts.rootCurrency && opts.fx) {
      d.setFont("helvetica", "normal");
      d.setFontSize(8);
      d.setTextColor(90, 90, 90);
      d.text(`Converted from ${opts.rootCurrency} at the current weekly rate.`, W - 14, y, { align: "right" });
      d.setTextColor(0, 0, 0);
      y += 6;
    }
  }
  if (po.notes) {
    d.setFont("helvetica", "normal");
    d.setFontSize(8);
    d.setTextColor(90, 90, 90);
    d.text(`Notes: ${pdfText(po.notes)}`, 14, y + 4, { maxWidth: W - 28 });
    d.setTextColor(0, 0, 0);
  }
  return d;
}

/** The browser half: build it, then hand it to the download. */
export async function downloadPoPdf(po: PurchaseOrder, opts: PoPdfOptions): Promise<void> {
  const d = await buildPoPdf(po, opts);
  d.save(poPdfFilename(po));
}
