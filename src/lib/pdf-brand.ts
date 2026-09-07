import type { jsPDF } from "jspdf";

// Shared Echo Barrier branding for generated PDFs (jsPDF). Single source for the
// mono logo (public/logo.jpg, 1119×215 ≈ 5.2:1) and the brand green (#025945, from
// echobarrier.com) so the invoice + PO documents stay visually consistent.
export const EB_GREEN: [number, number, number] = [2, 89, 69]; // #025945
const LOGO_ASPECT = 1119 / 215;

export async function loadLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch("/logo.jpg");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Draws the branded document header — mono logo (left), title + reference lines
 * (right), and a green rule — then returns the Y where body content should begin.
 */
export async function drawBrandHeader(
  d: jsPDF,
  W: number,
  opts: { title: string; refs: string[] }
): Promise<number> {
  try {
    const logo = await loadLogoDataUrl();
    if (logo) d.addImage(logo, "JPEG", 14, 12, 46, 46 / LOGO_ASPECT);
  } catch {
    /* the logo is optional — the document still renders without it */
  }
  d.setFont("helvetica", "bold");
  d.setFontSize(16);
  d.setTextColor(25, 25, 25);
  d.text(opts.title, W - 14, 18, { align: "right" });
  d.setFont("helvetica", "normal");
  d.setFontSize(9);
  d.setTextColor(90, 90, 90);
  d.text(opts.refs, W - 14, 25, { align: "right" });
  d.setDrawColor(EB_GREEN[0], EB_GREEN[1], EB_GREEN[2]);
  d.setLineWidth(0.8);
  d.line(14, 40, W - 14, 40);
  d.setTextColor(0, 0, 0);
  return 48;
}
