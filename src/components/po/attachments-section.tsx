"use client";

// page-state: none (an upload commits immediately; there is no draft between picking a file and having it)

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Paperclip, Download, Upload, Trash2 } from "lucide-react";
import {
  beginPoAttachmentUpload,
  finishPoAttachmentUpload,
  getPoAttachmentUrl,
  deletePoAttachment,
  setPoAttachmentShared,
} from "@/app/actions/purchase-orders/attachments";
import DetailSection from "@/components/po/detail-section";
import { createClient } from "@/lib/supabase/client";
import { PO_ATTACHMENT_BUCKET, PO_ATTACHMENT_MAX_BYTES } from "@/lib/po-attachments";
import type { PurchaseOrder } from "@/lib/erp-types";

/**
 * Shared by the purchase order board drawer and the single order page, so it is
 * not re-inlined.
 *
 * On a manufacturing order each file carries a tick that puts it on the
 * factory's own order page. Jozef Šidík, 18 Sep 2026: the order document has no
 * previews when it includes a logo. This is how the artwork reaches him, and it
 * is off until somebody turns it on, because everything else in this bucket is
 * a vendor invoice or a costed sheet.
 */
export default function AttachmentsSection({ po, canManage }: { po: PurchaseOrder; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const atts = po.attachments ?? [];
  // Only this leg has a manufacturer at the other end of it.
  const canShare = canManage && po.leg === "SRO_TO_SUPPLIER" && po.to_entity === "SUPPLIER";

  function toggleShare(id: string, shared: boolean) {
    setErr(null);
    startTransition(async () => {
      const res = await setPoAttachmentShared(id, shared);
      if (!res.success) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success(shared ? "The manufacturer can download this file" : "Hidden from the manufacturer");
      }
      router.refresh();
    });
  }

  function fail(message: string) {
    setErr(message);
    toast.error(message);
  }

  /** Browser to Storage with a signed token, never through a server action:
   *  Next caps an action's body at 1 MB. See src/lib/po-attachments.ts. */
  async function upload(file: File) {
    if (file.size > PO_ATTACHMENT_MAX_BYTES) {
      fail(`${file.name} is larger than 10 MB.`);
      return;
    }
    // Some browsers leave the type empty for uncommon extensions; the server and
    // the bucket both refuse that, and the server says so readably.
    const contentType = file.type || "application/octet-stream";
    const begun = await beginPoAttachmentUpload({
      poId: po.id,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    });
    if (!begun.success) {
      fail(`${file.name}: ${begun.error}`);
      return;
    }
    const { error } = await createClient()
      .storage.from(PO_ATTACHMENT_BUCKET)
      .uploadToSignedUrl(begun.path, begun.token, file);
    if (error) {
      fail(`${file.name} could not be uploaded: ${error.message}`);
      return;
    }
    const finished = await finishPoAttachmentUpload({
      poId: po.id,
      path: begun.path,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    });
    if (!finished.success) {
      fail(`${file.name}: ${finished.error}`);
      return;
    }
    toast.success(`${file.name} attached`);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    startTransition(async () => {
      try {
        await upload(file);
      } catch (error) {
        // Said here, never thrown: an error thrown inside a transition replaces
        // the whole page with the error card, which is what a large file did.
        console.error("PO attachment upload failed", error);
        fail(`${file.name} could not be uploaded. Please try again.`);
      } finally {
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      }
    });
  }

  async function download(id: string) {
    setErr(null);
    const res = await getPoAttachmentUrl(id);
    if (res.success) window.open(res.url, "_blank");
    else {
      setErr(res.error);
      toast.error(res.error);
    }
  }

  function remove(id: string) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr(null);
    startTransition(async () => {
      const res = await deletePoAttachment(id);
      if (!res.success) {
        setErr(res.error);
        toast.error(res.error);
      } else {
        toast.success("Attachment deleted");
      }
      router.refresh();
    });
  }

  return (
    <DetailSection label="Attachments">
      <div className="space-y-1.5">
        {atts.map((a) => (
          <div key={a.id} className="bg-gray-50 rounded-lg px-3 py-2">
            <div className="flex items-center justify-between gap-2">
            <button onClick={() => download(a.id)} className="flex items-center gap-2 min-w-0 text-left hover:opacity-80">
              <Paperclip className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
              <span className="text-xs text-gray-900 truncate">{a.filename}</span>
            </button>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => download(a.id)} className="text-gray-500 hover:text-echo-orange transition-colors" title="Download">
                <Download className="w-3.5 h-3.5" />
              </button>
              {canManage && (
                <button onClick={() => remove(a.id)} className="text-gray-500 hover:text-red-700 transition-colors" title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            </div>
            {canShare && (
              <label className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-600">
                <input
                  type="checkbox"
                  checked={a.share_with_manufacturer === true}
                  disabled={pending}
                  onChange={(e) => toggleShare(a.id, e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-echo-orange focus:ring-echo-orange"
                />
                Let the manufacturer download this from their order page
              </label>
            )}
            {!canShare && a.share_with_manufacturer === true && (
              <p className="mt-1.5 text-[11px] text-emerald-800">The manufacturer can download this.</p>
            )}
          </div>
        ))}
        {atts.length === 0 && <p className="text-[10px] text-gray-400">No files attached.</p>}
      </div>
      {canManage && (
        <>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={onPick}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
          >
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Attach file
          </button>
        </>
      )}
      {err && <p className="text-red-700 text-xs mt-2">{err}</p>}
    </DetailSection>
  );
}
