import { EB_GREEN, drawBrandHeader } from "@/lib/pdf-brand";
import { legLabel } from "@/lib/po-number";
import type { PurchaseOrder } from "@/lib/erp-types";

// Generates a branded PURCHASE ORDER PDF (EB logo + brand-green header) from a PO
// row on the board. Prices are shown only for cost.view holders — the non-cost
// version is the spec-only "worker" PO. Client-side (dynamic jsPDF import).
export async function downloadPoPdf(po: PurchaseOrder, opts: { chain: string; canViewCost: boolean }): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const d = new jsPDF();
  const W = d.internal.pageSize.width;
  const priced = opts.canViewCost;

  const refs = [
    `PO: ${opts.chain}`,
    `Number: ${po.po_number}`,
    `Date: ${(po.created_at ?? "").slice(0, 10)}`,
    ...(po.reference_po_number ? [`Reference: ${po.reference_po_number}`] : []),
  ];
  const partyY = await drawBrandHeader(d, W, { title: "PURCHASE ORDER", refs });

  // From (buyer) → To (supplier).
  d.setFontSize(9);
  d.setFont("helvetica", "bold");
  d.text("From (buyer)", 14, partyY);
  d.text("To (supplier)", W / 2 + 6, partyY);
  d.setFont("helvetica", "normal");
  d.text(po.from_entity, 14, partyY + 5);
  d.text(po.to_entity, W / 2 + 6, partyY + 5);

  const meta = [
    // jsPDF's built-in Helvetica can't render the "→" in the leg label — use ASCII.
    `Leg: ${legLabel(po.leg).replace(/→/g, "->")}`,
    `Status: ${po.status}`,
    ...(po.delivery_address ? [`Deliver to: ${po.delivery_address}`] : []),
  ];
  d.text(meta, 14, partyY + 16);

  const lines = po.lines ?? [];
  let total = 0;
  const head = priced
    ? [["Ln", "SKU", "Description", "Qty", "HS code", "Unit price", "Line total"]]
    : [["Ln", "SKU", "Description", "Qty", "HS code"]];
  const body = lines.map((l, i) => {
    const sku = `${l.sku}${l.sku_suffix ? `-${l.sku_suffix}` : ""}`;
    const base = [String(i + 1), sku, l.product_name ?? "", String(l.quantity), l.hs_code ?? "—"];
    if (!priced) return base;
    const up = l.unit_price ?? 0;
    const lt = up * l.quantity;
    total += lt;
    return [...base, up.toFixed(2), lt.toLocaleString("en-GB", { minimumFractionDigits: 2 })];
  });

  autoTable(d, {
    startY: partyY + 30,
    head,
    body,
    styles: { fontSize: 9 },
    headStyles: { fillColor: EB_GREEN, textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: priced ? { 5: { halign: "right" }, 6: { halign: "right" } } : {},
  });

  let y = ((d as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 120) + 8;
  if (priced) {
    d.setFont("helvetica", "bold");
    d.setFontSize(10);
    d.setTextColor(EB_GREEN[0], EB_GREEN[1], EB_GREEN[2]);
    d.text(`TOTAL   ${total.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`, W - 14, y, { align: "right" });
    d.setTextColor(0, 0, 0);
    y += 8;
  }
  if (po.notes) {
    d.setFont("helvetica", "normal");
    d.setFontSize(8);
    d.setTextColor(90, 90, 90);
    d.text(`Notes: ${po.notes}`, 14, y + 4, { maxWidth: W - 28 });
    d.setTextColor(0, 0, 0);
  }
  d.setFont("helvetica", "italic");
  d.setFontSize(7.5);
  d.text("Echo Barrier intercompany purchase order.", 14, 288);

  d.save(`${opts.chain.replace(/\s+/g, "")}.pdf`);
}
