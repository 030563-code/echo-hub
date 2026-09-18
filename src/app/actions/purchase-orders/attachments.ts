"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { poChainHeldBy } from "@/lib/po-organisations";

// ---------------------------------------------------------------------------
// PO file attachments. Objects live in the PRIVATE `po-attachments` bucket;
// storage.objects has no authenticated policy, so every object op goes through
// the service-role client here AFTER a capability check (upload / signed-url
// download / delete). Metadata rows are read via RLS (read-all authenticated),
// written service-role.
// ---------------------------------------------------------------------------

const BUCKET = "po-attachments";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MANAGE_CAPS = ["po.create", "po.approve", "po.receive"] as const;
const uuid = z.string().uuid();

export type AttachmentResult = { success: true } | { success: false; error: string };

export async function uploadPoAttachment(formData: FormData): Promise<AttachmentResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!MANAGE_CAPS.some((c) => auth.capabilities.has(c))) {
    return { success: false, error: "Forbidden: you can't attach files to purchase orders." };
  }

  const poId = formData.get("poId");
  const file = formData.get("file");
  if (typeof poId !== "string" || !uuid.safeParse(poId).success) {
    return { success: false, error: "Invalid PO id" };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: "No file provided" };
  }
  if (file.size > MAX_BYTES) {
    return { success: false, error: "File is larger than 10 MB." };
  }
  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED.has(contentType)) {
    return { success: false, error: `Unsupported file type (${contentType}).` };
  }

  const supabase = await createServerClient();
  const { data: po } = await supabase.from("purchase_orders").select("id").eq("id", poId).maybeSingle();
  if (!po) return { success: false, error: "Purchase order not found" };
  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { success: false, error: "Purchase order not found" };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
  const path = `${poId}/${randomUUID()}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const admin = createAdminClient();
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (upErr) {
    console.error("uploadPoAttachment storage upload failed", upErr.message);
    return { success: false, error: "Upload failed." };
  }

  const { error: rowErr } = await admin.from("po_attachments").insert({
    po_id: poId,
    storage_path: path,
    filename: safeName,
    content_type: contentType,
    size_bytes: file.size,
    uploaded_by_uid: auth.user.id,
  });
  if (rowErr) {
    // best-effort: don't leave an orphan object if the row failed
    await admin.storage.from(BUCKET).remove([path]);
    console.error("uploadPoAttachment row insert failed", rowErr.message);
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
