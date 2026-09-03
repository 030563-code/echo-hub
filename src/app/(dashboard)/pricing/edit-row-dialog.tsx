'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * One save-a-row dialog for all three pricing tables.
 *
 * The three tables differ only in their fields, so the pending state, the error
 * surface, the refresh and the light theming live here once. The caller owns
 * its own field state and hands over a save function, which keeps the
 * validation next to the fields it validates.
 */
export function EditRowDialog({
  title,
  trigger,
  children,
  onSave,
  onSaved,
  saveLabel = 'Save',
  disabled = false,
}: {
  title: string
  trigger: ReactNode
  children: ReactNode
  onSave: () => Promise<{ success: true } | { success: false; error: string }>
  onSaved?: () => void
  saveLabel?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSave() {
    setError(null)
    startTransition(async () => {
      const result = await onSave()
      if (result.success) {
        setOpen(false)
        onSaved?.()
      } else {
        // Kept on screen with the dialog open: the admin has just typed these
        // numbers and closing would lose them.
        setError(result.error)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-[480px] bg-white text-gray-900 border-gray-200">
        <DialogHeader>
          <DialogTitle className="text-gray-900">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">{children}</div>
        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || disabled}>
            {pending ? 'Saving...' : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
