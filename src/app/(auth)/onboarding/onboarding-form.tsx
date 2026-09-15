'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { completeOnboarding } from '@/app/actions/onboarding/complete-onboarding'
import { PIPELINE_CONFIG } from '@/lib/pipeline-config'

interface OnboardingFormProps {
  email: string
  defaultDisplayName: string
  suggestedPipelineId?: string
}

export default function OnboardingForm({ email, defaultDisplayName, suggestedPipelineId }: OnboardingFormProps) {
  const [displayName, setDisplayName] = useState(defaultDisplayName)
  const [pipelineId, setPipelineId] = useState(suggestedPipelineId ?? '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const selectedPipeline = PIPELINE_CONFIG.find((p) => p.pipelineId === pipelineId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }

    setSubmitting(true)
    const result = await completeOnboarding({
      display_name: displayName,
      pipeline_id: pipelineId || undefined,
      password,
    })
    setSubmitting(false)

    if (!result.success) {
      toast.error(result.error || 'Failed to complete onboarding')
      return
    }

    // A full page load, not router.replace(). This is where the password is set
    // for the first time, so it is the one moment Apple Passwords will offer to
    // save it, and it only offers after a real navigation follows the submit.
    window.location.assign('/')
  }

  return (
    <Card className="w-full max-w-md bg-[#111] border-gray-800">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-6">
          <Image
            src="/logo.jpg"
            alt="Echo Barrier"
            width={180}
            height={54}
            className="object-contain invert"
            priority
          />
        </div>
        <h1 className="text-2xl font-bold uppercase tracking-tighter text-white mb-2">
          Complete Your Profile
        </h1>
        <p className="text-gray-400 text-sm">Set up your account to get started</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Input
          label="Your Name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          className="border-gray-600 focus:border-echo-orange"
        />

        <div>
          <label className="block text-sm font-medium text-white mb-1">
            Your Region <span className="text-gray-500 font-normal">(sales users only)</span>
          </label>
          <Select value={pipelineId} onValueChange={setPipelineId}>
            <SelectTrigger className="h-11 sm:h-10 border-gray-600">
              <SelectValue placeholder="Select your sales region (optional)..." />
            </SelectTrigger>
            <SelectContent>
              {PIPELINE_CONFIG.map((p) => (
                <SelectItem key={p.pipelineId} value={p.pipelineId}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedPipeline && (
          <div className="bg-gray-900 border border-gray-800 rounded-[5px] p-3 text-xs space-y-1">
            <p className="text-gray-400 font-medium uppercase tracking-wider mb-2">Region Access</p>
            <p className="text-gray-300">
              <span className="text-gray-500">Depots: </span>
              {selectedPipeline.allowedDepots.map((d) => d.value).join(', ')}
            </p>
            {selectedPipeline.allowedDistributors.length > 0 && (
              <p className="text-gray-300">
                <span className="text-gray-500">Distributors: </span>
                {selectedPipeline.allowedDistributors.join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Read-only, but a real field on purpose: a password manager needs a
            username in the same form to know which account it is saving this
            password against. Hiding it entirely is what leaves an unnamed entry. */}
        <Input
          label="Your Login Email"
          id="username"
          name="username"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          className="border-gray-600 text-gray-400"
        />

        <Input
          label="Password"
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          placeholder="Min. 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="border-gray-600 focus:border-echo-orange"
        />

        <Input
          label="Confirm Password"
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          placeholder="Repeat password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          className="border-gray-600 focus:border-echo-orange"
        />

        <Button type="submit" variant="primary" className="w-full min-h-11 sm:min-h-0" disabled={submitting}>
          {submitting ? 'Saving...' : 'Complete Setup'}
        </Button>
      </form>
    </Card>
  )
}
