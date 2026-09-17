'use client'

// page-state: none (dialog-scoped, nothing typed)

import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { phoneUrl } from '@/lib/open-on-phone'
import { cn } from '@/lib/utils'

type CopyState = 'idle' | 'copied' | 'manual'

const COPIED_MS = 2000

/**
 * Labels the caller can override, so an outside company reads its own language.
 *
 * 🔴 The dialog was English on a Slovak screen, the same fault as the rail. It also carries the one
 * instruction the factory most needs, how to keep the Hub on a phone, so English here meant the
 * people it was written for could not read it.
 */
export interface PhoneLabels {
  phoneOpenLabel: string
  phoneTitle: string
  phoneLead: string
  phoneInstall: string
  phoneCopy: string
  phoneCopied: string
  phoneCopyManual: string
}

const EN: PhoneLabels = {
  phoneOpenLabel: 'Open this page on your phone',
  phoneTitle: 'Open on your phone',
  phoneLead: "Point your phone's camera at the code. The same page opens in your phone's browser.",
  phoneInstall:
    'Sign in the first time. To keep the Hub on your phone: on iPhone, tap Share, then Add to Home Screen. On Android, open the browser menu, then Add to Home screen.',
  phoneCopy: 'Copy link',
  phoneCopied: 'Copied',
  phoneCopyManual: 'Select the link and copy it',
}

export function OpenOnPhone({ className, labels }: { className?: string; labels?: PhoneLabels }) {
  const t = labels ?? EN
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [copy, setCopy] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function handleOpenChange(next: boolean) {
    if (next) {
      // Read at the moment of opening, so the code always matches the page on
      // screen, including a query string changed since the page loaded.
      setUrl(phoneUrl(window.location.href))
      setCopy('idle')
    }
    setOpen(next)
  }

  function copyLink() {
    if (timer.current) clearTimeout(timer.current)
    // navigator.clipboard is missing outside a secure context and in some
    // embedded browsers. Say what to do instead of doing nothing.
    if (!navigator.clipboard?.writeText) {
      setCopy('manual')
      return
    }
    navigator.clipboard.writeText(url).then(
      () => {
        setCopy('copied')
        timer.current = setTimeout(() => setCopy('idle'), COPIED_MS)
      },
      () => setCopy('manual'),
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t.phoneOpenLabel}
          title={t.phoneOpenLabel}
          className={cn(
            'flex h-11 w-11 lg:h-10 lg:w-10 items-center justify-center rounded text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-echo-orange/50',
            className,
          )}
        >
          <Smartphone className="h-5 w-5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t.phoneTitle}</DialogTitle>
          <DialogDescription>{t.phoneLead}</DialogDescription>
        </DialogHeader>

        {url && (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <QRCodeSVG
                value={url}
                size={224}
                level="M"
                marginSize={2}
                fgColor="#000000"
                bgColor="#FFFFFF"
                role="img"
                aria-label={`QR code for ${url}`}
              />
            </div>

            <p className="text-center text-xs text-muted-foreground">{t.phoneInstall}</p>

            <div className="w-full space-y-2">
              <p
                data-testid="open-on-phone-url"
                className="select-all break-all rounded border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-700"
              >
                {url}
              </p>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {copy === 'manual' && t.phoneCopyManual}
                  {copy === 'copied' && <span className="sr-only">{t.phoneCopied}</span>}
                </p>
                <button
                  type="button"
                  onClick={copyLink}
                  className="shrink-0 rounded-[5px] border border-echo-orange px-4 py-2 text-xs font-bold text-echo-orange hover:bg-echo-orange hover:text-white focus:outline-none focus:ring-2 focus:ring-echo-orange/50"
                >
                  {copy === 'copied' ? t.phoneCopied : t.phoneCopy}
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
