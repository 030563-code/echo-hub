'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Download, Loader2, Paperclip, Trash2, Upload } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import {
  attachmentDownloadUrl,
  beginAttachmentUpload,
  deleteInvoiceAttachment,
  finishAttachmentUpload,
  type InvoiceAttachmentRow,
} from '@/app/actions/invoicing/attachments'
import { MAX_ATTACHMENT_BYTES } from '@/lib/customer-invoice/attachment-path'

/**
 * Drag and drop files onto an invoice.
 *
 * The bytes go BROWSER to STORAGE, never through a server action: Next's
 * default 1 MB body limit would otherwise cap an attachment near 750 KB once
 * base64 is accounted for. The server mints a signed upload token against a
 * path it chooses, the browser uploads, then the server records the row.
 *
 * Internal only, by Dean's decision. These files are for the team and, later,
 * for Xero; the customer's email carries the invoice PDF and nothing else.
 */

const BUCKET = 'invoice-attachments'

function formatBytes(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function InvoiceAttachments({
  invoiceId,
  attachments,
  canManage,
}: {
  invoiceId: string
  attachments: InvoiceAttachmentRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const uploadOne = async (file: File) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`${file.name} is larger than 20 MB.`)
      return
    }
    // Some browsers leave type empty for uncommon extensions; the server and
    // the bucket both refuse a blank type, so say so here rather than there.
    const contentType = file.type || 'application/octet-stream'

    setUploading((current) => [...current, file.name])
    try {
      const begun = await beginAttachmentUpload({
        invoiceId,
        filename: file.name,
        contentType,
        sizeBytes: file.size,
      })
      if (!begun.success) {
        toast.error(`${file.name}: ${begun.error}`)
        return
      }

      const supabase = createClient()
      const { error } = await supabase.storage
        .from(BUCKET)
        .uploadToSignedUrl(begun.path, begun.token, file)
      if (error) {
        toast.error(`${file.name} could not be uploaded: ${error.message}`)
        return
      }

      const finished = await finishAttachmentUpload({
        invoiceId,
        path: begun.path,
        filename: file.name,
        contentType,
        sizeBytes: file.size,
      })
      if (!finished.success) {
        toast.error(`${file.name}: ${finished.error}`)
        return
      }
      toast.success(`${file.name} attached.`)
      router.refresh()
    } finally {
      setUploading((current) => current.filter((name) => name !== file.name))
    }
  }

  /** Sequential on purpose: a dropped folder of twenty files should not open
   *  twenty signed uploads at once, and the progress list stays readable. */
  const uploadAll = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) await uploadOne(file)
  }

  const download = async (attachment: InvoiceAttachmentRow) => {
    if (busyId) return
    setBusyId(attachment.id)
    try {
      const result = await attachmentDownloadUrl({ attachmentId: attachment.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      window.open(result.url, '_blank', 'noopener,noreferrer')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (attachment: InvoiceAttachmentRow) => {
    if (busyId) return
    if (!window.confirm(`Delete ${attachment.filename}? This cannot be undone.`)) return
    setBusyId(attachment.id)
    try {
      const result = await deleteInvoiceAttachment({ attachmentId: attachment.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Attachment deleted.')
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card className="bg-white border-gray-200 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Paperclip className="h-4 w-4 text-gray-400" />
        <h3 className="text-lg font-semibold text-gray-900">Attachments</h3>
        <span className="text-xs text-gray-500">
          Internal. Not sent to the customer with the invoice.
        </span>
      </div>

      {canManage && (
        <div
          data-testid="attachment-dropzone"
          // preventDefault on dragOver is what makes a drop fire at all.
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragEnter={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            void uploadAll(e.dataTransfer.files)
          }}
          className={`rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            over ? 'border-echo-yellow bg-yellow-50' : 'border-gray-200 bg-gray-50'
          }`}
        >
          <Upload className="mx-auto mb-2 h-5 w-5 text-gray-400" />
          <p className="text-sm text-gray-700">Drag files here to attach them to this invoice</p>
          <p className="mt-1 text-xs text-gray-500">
            PDF, images, Word, Excel, CSV or text. Up to 20 MB each.
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            aria-label="Choose files to attach"
            onChange={(e) => {
              void uploadAll(e.target.files)
              // Clear it, or choosing the same file twice in a row does nothing.
              e.target.value = ''
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => fileInput.current?.click()}
          >
            Choose files
          </Button>
        </div>
      )}

      {uploading.length > 0 && (
        <ul className="mt-3 space-y-1">
          {uploading.map((name) => (
            <li key={name} className="flex items-center gap-2 text-xs text-gray-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              Uploading {name}...
            </li>
          ))}
        </ul>
      )}

      {attachments.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">Nothing attached yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-2 rounded border border-gray-100 bg-gray-50 px-3 py-2"
            >
              <span className="font-medium text-gray-900">{attachment.filename}</span>
              <span className="text-xs text-gray-500">{formatBytes(attachment.size_bytes)}</span>
              <span className="ml-auto text-xs text-gray-500">
                {formatDate(attachment.created_at)}
                {attachment.uploaded_by_label ? ` by ${attachment.uploaded_by_label}` : ''}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(attachment)}
                disabled={busyId !== null}
              >
                <Download className="mr-1.5 h-4 w-4" />
                Download
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => remove(attachment)}
                  disabled={busyId !== null}
                  className="text-red-700 hover:text-red-800"
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
