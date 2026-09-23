"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser, type AuthzOk } from "@/lib/authz";
import { poChainHeldBy } from "@/lib/po-organisations";
import {
  PO_ATTACHMENT_BUCKET,
  checkPoAttachment,
  isPathInsidePo,
  poAttachmentPath,
} from "@/lib/po-attachments";
import { safeAttachmentName } from "@/lib/customer-invoice/attachment-path";

// ---------------------------------------------------------------------------
// PO file attachments. Objects live in the PRIVATE `po-attachments` bucket;
// storage.objects has no authenticated policy, so every object op goes through
// the service-role client here AFTER a capability check (signed upload /
// signed-url download / delete). Metadata rows are read via RLS (read-all
// authenticated), written service-role.
//
// 🔴 THE BYTES NEVER PASS THROUGH A SERVER ACTION. Next caps an action's body
// at 1 MB, so a PDF posted here failed inside Next and took the page down
// (23 Sep 2026, "H10 2026 Celtic.pdf"). The browser uploads straight to Storage
// with a signed token minted against a path THIS FILE chose, then calls back to
// record the row. See src/lib/po-attachments.ts.
// ---------------------------------------------------------------------------

const BUCKET = PO_ATTACHMENT_BUCKET;

const MANAGE_CAPS = ["po.create", "po.approve", "po.receive"] as const;
const uuid = z.string().uuid();

export type AttachmentResult = { success: true } | { success: false; error: string };

export type BeginPoUploadResult =
  | { success: true; path: string; token: string }
  | { success: false; error: string };

/** The person may attach files, and the order is one their organisations hold. */
async function gateAttach(poId: string): Promise<{ ok: true; auth: AuthzOk } | { ok: false; error: string }> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!MANAGE_CAPS.some((c) => auth.capabilities.has(c))) {
    return { ok: false, error: "Forbidden: you can't attach files to purchase orders." };
  }
  const supabase = await createServerClient();
  const { data: po } = await supabase.from("purchase_orders").select("id").eq("id", poId).maybeSingle();
  if (!po || !(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false, error: "Purchase order not found" };
  }
  return { ok: true, auth };
}

const BeginInput = z.object({
  poId: uuid,
  filename: z.string().trim().min(1).max(300),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
});

/** Checks the person, the order, the size and the type, then mints a signed
 *  upload for a path chosen here. The browser sends the file itself. */
export async function beginPoAttachmentUpload(input: unknown): Promise<BeginPoUploadResult> {
  const parsed = BeginInput.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid file" };
  }
  const { poId, filename, contentType, sizeBytes } = parsed.data;

  const gate = await gateAttach(poId);
  if (!gate.ok) return { success: false, error: gate.error };

  const allowed = checkPoAttachment(contentType, sizeBytes);
  if (!allowed.ok) return { success: false, error: allowed.error };

  // The server picks the path. This is the whole containment guarantee.
  const path = poAttachmentPath(poId, randomUUID(), filename);
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("beginPoAttachmentUpload signing failed", error?.message);
    return { success: false, error: "Could not start the upload. Please try again." };
  }
  return { success: true, path: data.path, token: data.token };
}

const FinishInput = BeginInput.extend({ path: z.string().trim().min(1).max(500) });

/** Records the row once the object is really in Storage at the minted path. */
export async function finishPoAttachmentUpload(input: unknown): Promise<AttachmentResult> {
  const parsed = FinishInput.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid file" };
  }
  const { poId, path, filename, contentType, sizeBytes } = parsed.data;

  const gate = await gateAttach(poId);
  if (!gate.ok) return { success: false, error: gate.error };

  // The path comes back from the browser, so it is re-checked rather than
  // trusted: this is what stops a crafted call recording another order's file.
  if (!isPathInsidePo(path, poId)) {
    return { success: false, error: "That file does not belong to this purchase order." };
  }

  // Confirm the object is actually there, or the list would offer a download
  // that 404s.
  const admin = createAdminClient();
  const objectName = path.slice(poId.length + 1);
  const { data: listed, error: listError } = await admin.storage
    .from(BUCKET)
    .list(poId, { search: objectName, limit: 1 });
  if (listError) {
    console.error("finishPoAttachmentUpload list failed", listError.message);
    return { success: false, error: "Could not confirm the upload. Please try again." };
  }
  const object = (listed ?? []).find((item) => item.name === objectName);
  if (!object) return { success: false, error: "The upload did not complete. Please try again." };
  const storedSize = Number(object.metadata?.size);

  const { error: rowErr } = await admin.from("po_attachments").insert({
    po_id: poId,
    storage_path: path,
    filename: safeAttachmentName(filename),
    content_type: contentType,
    size_bytes: Number.isFinite(storedSize) && storedSize > 0 ? storedSize : sizeBytes,
    uploaded_by_uid: gate.auth.user.id,
  });
  if (rowErr) {
    // The object is uploaded but unrecorded. Remove it rather than leave a file
    // nothing points at.
    await admin.storage.from(BUCKET).remove([path]);
    console.error("finishPoAttachmentUpload row insert failed", rowErr.message);
    return { success: false, error: "Upload failed." };
  }

  revalidatePath("/purchase-orders");
  return { success: true };
}

export async function getPoAttachmentUrl(
  attachmentId: string
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  // Attachments are opaque (a vendor invoice can carry prices), so the slice-3
  // server-side price stripping can't reach them — gate download on cost.view,
  // like every other price surface. (Future: a per-file 'sensitive' flag could
  // let workers open non-priced docs.)
  if (!auth.capabilities.has("cost.view")) {
    return { success: false, error: "Forbidden: cost visibility (cost.view) is required to open attachments." };
  }
  if (!uuid.safeParse(attachmentId).success) return { success: false, error: "Invalid id" };

  const supabase = await createServerClient();
  const { data: att } = await supabase
    .from("po_attachments")
    .select("storage_path, po_id")
    .eq("id", attachmentId)
    .maybeSingle();
  if (!att) return { success: false, error: "Attachment not found" };
  if (!(await poChainHeldBy(String(att.po_id), auth.profile.organisations))) {
    return { success: false, error: "Attachment not found" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(att.storage_path, 300);
  if (error || !data) {
    console.error("getPoAttachmentUrl signing failed", error?.message);
    return { success: false, error: "Could not generate a download link." };
  }
  return { success: true, url: data.signedUrl };
}

/**
 * Tick a file for the manufacturer, or untick it.
 *
 * Jozef Šidík, 18 Sep 2026, on the order document: no previews when the order
 * includes a logo. Rather than build an artwork pipeline, Juraj and Martin put
 * the file they already have on the purchase order and tick it; the factory
 * downloads it from the order page. Dean chose the page over the email.
 *
 * 🔴 ONE FILE AT A TIME, AND NEVER BY DEFAULT. The rest of this bucket is
 * internal: vendor invoices and costed sheets, which is why opening one needs
 * cost.view. Ticking is the deliberate act that lets exactly one file out, and
 * the same people who may attach may tick.
 */
export async function setPoAttachmentShared(
  attachmentId: string,
  shared: boolean
): Promise<AttachmentResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!MANAGE_CAPS.some((c) => auth.capabilities.has(c))) {
    return { success: false, error: "You can't change purchase order files." };
  }
  // 🔴 Sharing needs cost.view, the same capability opening the file needs.
  // po.receive is the warehouse, and cost.view is deliberately withheld from
  // warehouse and production accounts, so without this a receiving clerk could
  // publish a costed vendor invoice to the manufacturer that they themselves
  // are refused when they click it. Unticking stays open: taking a file back is
  // never the dangerous direction.
  if (shared && !auth.capabilities.has("cost.view")) {
    return {
      success: false,
      error: "Forbidden: cost visibility (cost.view) is required to send a file to the manufacturer.",
    };
  }
  if (!uuid.safeParse(attachmentId).success) return { success: false, error: "Invalid id" };
  if (typeof shared !== "boolean") return { success: false, error: "Invalid value" };

  const supabase = await createServerClient();
  const { data: att } = await supabase
    .from("po_attachments")
    .select("id, po_id")
    .eq("id", attachmentId)
    .maybeSingle();
  if (!att) return { success: false, error: "Attachment not found" };
  if (!(await poChainHeldBy(String(att.po_id), auth.profile.organisations))) {
    return { success: false, error: "Attachment not found" };
  }

  // Only the manufacturing leg reaches a manufacturer. Ticking a file on a
  // depot order would be a promise the factory screens can never keep, because
  // they only ever see SRO_TO_SUPPLIER orders.
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("leg, to_entity")
    .eq("id", String(att.po_id))
    .maybeSingle<{ leg: string; to_entity: string }>();
  if (shared && (po?.leg !== "SRO_TO_SUPPLIER" || po?.to_entity !== "SUPPLIER")) {
    return { success: false, error: "Only files on a manufacturing order can be sent to the manufacturer." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("po_attachments")
    .update({ share_with_manufacturer: shared })
    .eq("id", attachmentId);
  if (error) {
    console.error("setPoAttachmentShared failed", error.message);
    return { success: false, error: "Could not change the file." };
  }
  revalidatePath("/purchase-orders");
  return { success: true };
}

export async function deletePoAttachment(attachmentId: string): Promise<AttachmentResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!uuid.safeParse(attachmentId).success) return { success: false, error: "Invalid id" };

  const supabase = await createServerClient();
  const { data: att } = await supabase
    .from("po_attachments")
    .select("id, storage_path, uploaded_by_uid, po_id")
    .eq("id", attachmentId)
    .maybeSingle();
  if (!att) return { success: false, error: "Attachment not found" };
  if (!(await poChainHeldBy(String(att.po_id), auth.profile.organisations))) {
    return { success: false, error: "Attachment not found" };
  }

  // The uploader, an approver, or an admin may delete.
  const isOwner = att.uploaded_by_uid === auth.user.id;
  if (!isOwner && !auth.capabilities.has("po.approve") && !auth.capabilities.has("admin")) {
    return { success: false, error: "Forbidden: only the uploader or an approver can delete this." };
  }

  const admin = createAdminClient();
  await admin.storage.from(BUCKET).remove([att.storage_path]);
  const { error } = await admin.from("po_attachments").delete().eq("id", attachmentId);
  if (error) {
    console.error("deletePoAttachment failed", error.message);
    return { success: false, error: "Delete failed." };
  }
  revalidatePath("/purchase-orders");
  return { success: true };
}
