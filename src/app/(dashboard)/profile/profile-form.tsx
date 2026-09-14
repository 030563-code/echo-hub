'use client'

// page-state: draft profile:details (the job title and bio; the photo preview is transient)

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Avatar } from '@/components/profile/avatar'
import { DraftStrip } from '@/components/page-state/draft-strip'
import { usePageState } from '@/hooks/use-page-state'
import { removeAvatar, updateProfileDetails, uploadAvatar } from '@/app/actions/profile'
import { PROFILE_DETAILS_KEY, parseProfileDetailsDraft, type ProfileDetailsDraft } from '@/lib/page-drafts'
import { AVATAR_EDGE, AVATAR_MAX_BYTES, BIO_MAX, JOB_TITLE_MAX, avatarSrc } from '@/lib/profile/avatar'

/** Anything bigger is refused before decoding, so a huge file cannot stall the tab. */
const PICK_MAX_BYTES = 10 * 1024 * 1024

/** Tried in order until the JPEG fits under AVATAR_MAX_BYTES. */
const JPEG_QUALITIES = [0.88, 0.8, 0.72, 0.64, 0.56, 0.48]

const UNREADABLE = 'That photo could not be read. Choose a JPEG, PNG or WebP photo.'

class PhotoError extends Error {}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/**
 * Turn whatever was picked into a square JPEG, AVATAR_EDGE pixels on a side.
 *
 * Drawing to a canvas and encoding afresh keeps only the pixels, so the EXIF
 * block a phone writes into a photo, GPS location included, never leaves the
 * browser. imageOrientation 'from-image' applies the EXIF rotation first, so a
 * portrait phone photo is not stored on its side.
 */
async function encodeAvatar(file: File): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PhotoError(UNREADABLE)
  }

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_EDGE
  canvas.height = AVATAR_EDGE
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx || bitmap.width === 0 || bitmap.height === 0) throw new PhotoError(UNREADABLE)
    // Centre crop to a square.
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    // JPEG has no transparency; without a fill a transparent PNG turns black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, AVATAR_EDGE, AVATAR_EDGE)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_EDGE, AVATAR_EDGE)
  } finally {
    bitmap.close()
  }

  for (const quality of JPEG_QUALITIES) {
    const blob = await canvasToJpeg(canvas, quality)
    if (!blob) throw new PhotoError(UNREADABLE)
    if (blob.size <= AVATAR_MAX_BYTES) return blob
  }
  throw new PhotoError('That photo is too detailed to shrink to 512 KB. Try a different photo.')
}

interface Props {
  userId: string
  email: string | null
  displayName: string | null
  jobTitle: string | null
  bio: string | null
  avatarUpdatedAt: string | null
}

const labelCls = 'block text-sm font-medium text-gray-900'

export default function ProfileForm({
  userId,
  email,
  displayName,
  jobTitle: savedJobTitle,
  bio: savedBio,
  avatarUpdatedAt,
}: Props) {
  // ------------------------------------------------------------------
  // Photo. The chosen preview lives in memory only and is never saved as
  // page state: it is a decoded image, and a half-chosen photo is not work
  // anyone would want back.
  // ------------------------------------------------------------------
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<'reading' | 'saving' | 'removing' | null>(null)

  const previewUrl = preview?.url ?? null
  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const currentSrc = avatarSrc(userId, avatarUpdatedAt)

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset so picking the same file again still fires a change.
    event.target.value = ''
    if (!file) return
    setPhotoError(null)
    if (file.size > PICK_MAX_BYTES) {
      setPhotoError('That photo is larger than 10 MB. Choose a smaller one.')
      return
    }
    setPhotoBusy('reading')
    try {
      const blob = await encodeAvatar(file)
      setPreview({ blob, url: URL.createObjectURL(blob) })
    } catch (err) {
      setPhotoError(err instanceof PhotoError ? err.message : UNREADABLE)
    } finally {
      setPhotoBusy(null)
    }
  }

  async function savePhoto() {
    if (!preview) return
    setPhotoBusy('saving')
    setPhotoError(null)
    try {
      const formData = new FormData()
      formData.append('file', preview.blob, 'avatar.jpg')
      const res = await uploadAvatar(formData)
      if (res.success) {
        setPreview(null)
        toast.success('Your photo is saved.')
      } else {
        setPhotoError(res.error)
        toast.error(res.error)
      }
    } catch {
      const message = 'Your photo could not be saved. Check your connection and try again.'
      setPhotoError(message)
      toast.error(message)
    } finally {
      setPhotoBusy(null)
    }
  }

  async function deletePhoto() {
    setPhotoBusy('removing')
    setPhotoError(null)
    try {
      const res = await removeAvatar()
      if (res.success) toast.success('Your photo is removed.')
      else {
        setPhotoError(res.error)
        toast.error(res.error)
      }
    } catch {
      const message = 'Your photo could not be removed. Check your connection and try again.'
      setPhotoError(message)
      toast.error(message)
    } finally {
      setPhotoBusy(null)
    }
  }

  // ------------------------------------------------------------------
  // Details: job title and bio. Typed content, so a page-state draft.
  // ------------------------------------------------------------------
  const [jobTitle, setJobTitle] = useState(savedJobTitle ?? '')
  const [bio, setBio] = useState(savedBio ?? '')
  const [savingDetails, setSavingDetails] = useState(false)

  const savedJson = JSON.stringify({ v: 1, jobTitle: savedJobTitle ?? '', bio: savedBio ?? '' })

  const {
    status: draftStatus,
    restored,
    save: saveDraft,
    clear: clearDraft,
    saveStatus: draftSaveStatus,
    savedAt: draftSavedAt,
  } = usePageState<ProfileDetailsDraft>({
    pageKey: PROFILE_DETAILS_KEY,
    parse: parseProfileDetailsDraft,
    onRestore: (draft) => {
      if (!draft) return
      setJobTitle(draft.data.jobTitle)
      setBio(draft.data.bio)
    },
    // Nothing is written while a save is on its way, so a queued draft cannot
    // land after the server has already cleared it.
    enabled: !savingDetails,
    // Matching what is already saved is not a draft.
    isEmpty: (draft) => JSON.stringify(draft) === savedJson,
  })
  const draftReady = draftStatus === 'ready'

  useEffect(() => {
    if (!draftReady) return
    saveDraft({ v: 1, jobTitle, bio })
  }, [draftReady, saveDraft, jobTitle, bio])

  const showDraftStrip = restored !== null && JSON.stringify(restored.data) !== savedJson
  const changed = jobTitle.trim() !== (savedJobTitle ?? '') || bio.trim() !== (savedBio ?? '')

  async function startAgain() {
    await clearDraft()
    setJobTitle(savedJobTitle ?? '')
    setBio(savedBio ?? '')
  }

  async function saveDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSavingDetails(true)
    try {
      const res = await updateProfileDetails({ jobTitle, bio })
      if (res.success) {
        await clearDraft()
        // The server stores the trimmed text; show exactly that.
        setJobTitle(jobTitle.trim())
        setBio(bio.trim())
        toast.success('Your details are saved.')
      } else {
        toast.error(res.error)
      }
    } catch {
      toast.error('Your details could not be saved. Check your connection and try again.')
    } finally {
      setSavingDetails(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="bg-white border-gray-200 p-6 rounded-xl">
        <h2 className="text-base font-semibold text-gray-900">Photo</h2>
        <div className="mt-4 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          {preview ? (
            // Not next/image: the preview is a blob url that exists only in this tab.
            // eslint-disable-next-line @next/next/no-img-element -- a blob url cannot go through the image optimiser
            <img
              src={preview.url}
              alt="Preview of your new photo"
              className="h-24 w-24 shrink-0 rounded-full object-cover bg-gray-100"
            />
          ) : (
            <div data-testid="profile-avatar">
              <Avatar src={currentSrc} name={displayName} email={email} size="lg" />
            </div>
          )}

          <div className="space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onPick}
              aria-label="Choose a photo"
            />
            <div className="flex flex-wrap items-center gap-2">
              {preview ? (
                <>
                  <Button type="button" size="sm" onClick={savePhoto} disabled={photoBusy !== null}>
                    {photoBusy === 'saving' ? 'Saving photo…' : 'Save photo'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPreview(null)
                      setPhotoError(null)
                    }}
                    disabled={photoBusy !== null}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => inputRef.current?.click()}
                    disabled={photoBusy !== null}
                  >
                    {photoBusy === 'reading' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Reading photo…
                      </span>
                    ) : (
                      'Upload photo'
                    )}
                  </Button>
                  {currentSrc && (
                    <Button type="button" size="sm" variant="ghost" onClick={deletePhoto} disabled={photoBusy !== null}>
                      {photoBusy === 'removing' ? 'Removing photo…' : 'Remove photo'}
                    </Button>
                  )}
                </>
              )}
            </div>
            <p className="text-xs text-gray-500">
              {preview
                ? 'This is how your photo will look. Save it to use it.'
                : 'A JPEG, PNG or WebP photo up to 10 MB. It is cropped to a square.'}
            </p>
            {photoError && (
              <p className="text-sm text-red-600" role="alert">
                {photoError}
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="bg-white border-gray-200 p-6 rounded-xl">
        <h2 className="text-base font-semibold text-gray-900">Your details</h2>

        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-gray-500">Name</dt>
            <dd className="text-sm text-gray-900">{displayName?.trim() || 'Not set'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Email</dt>
            <dd className="text-sm text-gray-900 break-all">{email ?? 'Not set'}</dd>
          </div>
        </dl>

        {!draftReady ? (
          <p className="mt-6 text-sm text-gray-600">Opening your details…</p>
        ) : (
          <form onSubmit={saveDetails} className="mt-6 space-y-5">
            {showDraftStrip && (
              <DraftStrip
                what="your unsaved details"
                savedAt={draftSavedAt}
                onStartAgain={startAgain}
                startAgainLabel="Discard these changes"
                saveStatus={draftSaveStatus}
              />
            )}

            <div>
              <label htmlFor="profile-job-title" className={labelCls}>
                Job title
              </label>
              <Input
                id="profile-job-title"
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Operations Manager"
                maxLength={JOB_TITLE_MAX}
                autoComplete="organization-title"
              />
            </div>

            <div>
              <label htmlFor="profile-bio" className={labelCls}>
                Bio
              </label>
              <Textarea
                id="profile-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="What you look after, and what people come to you for."
                maxLength={BIO_MAX}
                rows={5}
                aria-describedby="profile-bio-count"
              />
              <p id="profile-bio-count" className="mt-1 text-right text-xs text-gray-500 tabular-nums">
                {bio.length} / {BIO_MAX}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={savingDetails || !changed}>
                {savingDetails ? 'Saving details…' : 'Save details'}
              </Button>
              {!changed && !savingDetails && <span className="text-xs text-gray-500">No changes to save.</span>}
            </div>
          </form>
        )}
      </Card>
    </div>
  )
}
