'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getRepAgentOptions } from '@/app/actions/hubspot/getDealProperties'
import { updateDealProperties } from '@/app/actions/hubspot/updateDealProperties'
import {
  REP_AGENT_LABEL,
  REP_AGENT_PROPERTY,
  isKnownRepAgent,
  repAgentFallbackOptions,
} from '@/lib/deal-properties'

/**
 * The rep agent picker, used on the deal page and in the quote builder setup.
 *
 * Two modes, because the two surfaces commit at different times:
 *
 * - `mode="save"` (deal page) writes straight to HubSpot on change, through the
 *   existing generic updateDealProperties action. That action already enforces
 *   assertDealAccess(dealId, 'quotes.create') and its BLOCKED_PROPERTIES set
 *   does not contain this property, so no bespoke write path is needed.
 * - `mode="defer"` (quote builder) only reports upward, and createQuote writes
 *   the value with everything else. A quote that fails must not leave the rep
 *   agent behind on the deal.
 *
 * The option list is fetched live so an option added in HubSpot appears without
 * a deploy, and falls back to the five known values when that call fails. An
 * empty select used to be able to brick a form with no error message, which is
 * the reason the fallback exists at all.
 */

export type RepAgentMode = 'save' | 'defer'

export function RepAgentSelect({
  dealId,
  value,
  canEdit,
  mode = 'save',
  onChange,
}: {
  dealId: string
  value: string | null | undefined
  canEdit: boolean
  mode?: RepAgentMode
  /** Required for mode="defer"; ignored for mode="save". */
  onChange?: (value: string) => void
}) {
  const router = useRouter()
  const [options, setOptions] = useState<{ label: string; value: string }[]>(repAgentFallbackOptions())
  const [selected, setSelected] = useState(String(value ?? '').trim())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    getRepAgentOptions()
      .then((result) => {
        if (live && result.success && result.data && result.data.length > 0) setOptions(result.data)
      })
      // The fallback is already in state, so a failure here is not worth a toast.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // A value the property no longer offers would render as a blank trigger and
  // look like "not set", so show it as text rather than silently losing it.
  const unknownExisting = selected !== '' && !isKnownRepAgent(selected, options)

  async function handleChange(next: string) {
    const previous = selected
    setSelected(next)

    if (mode === 'defer') {
      onChange?.(next)
      return
    }

    setSaving(true)
    try {
      const result = await updateDealProperties(dealId, { [REP_AGENT_PROPERTY]: next })
      if (result.success) {
        toast.success(`${REP_AGENT_LABEL} set to ${next}`)
        router.refresh()
      } else {
        // Put the old value back, or the screen claims a change HubSpot refused.
        setSelected(previous)
        toast.error(result.error ?? `Could not save the ${REP_AGENT_LABEL.toLowerCase()}`)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-gray-900">
        {selected || <span className="text-gray-400">Not set</span>}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      <Select value={selected} onValueChange={handleChange} disabled={saving}>
        <SelectTrigger className="h-11 sm:h-10 bg-white border-gray-300 text-gray-900">
          <SelectValue placeholder={saving ? 'Saving...' : `Choose ${REP_AGENT_LABEL.toLowerCase()}...`} />
        </SelectTrigger>
        <SelectContent className="bg-white border-gray-200 text-gray-900">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {unknownExisting && (
        <p className="text-xs text-amber-700">
          Currently set to &ldquo;{selected}&rdquo;, which is no longer one of the options in HubSpot.
        </p>
      )}
    </div>
  )
}
