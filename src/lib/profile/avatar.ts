/**
 * Profile job title, bio and photo: the rules both sides of the wire share.
 *
 * Pure on purpose (no server-only imports, no Supabase), so the browser form,
 * the server action, the image route and the unit tests all read the same
 * numbers and the same checks.
 */

/** The longest job title the database accepts (profiles_job_title_length). */
export const JOB_TITLE_MAX = 80

/** The longest bio the database accepts (profiles_bio_length). */
export const BIO_MAX = 500

/** The largest stored photo, matching the avatars bucket's file_size_limit. */
export const AVATAR_MAX_BYTES = 512 * 1024

/** The private Storage bucket that holds one photo per user. */
export const AVATAR_BUCKET = 'avatars'

/** The browser crops every photo to a square this many pixels on a side. */
export const AVATAR_EDGE = 512

export type AvatarImageType = 'image/jpeg' | 'image/png' | 'image/webp'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false
  return prefix.every((b, i) => bytes[offset + i] === b)
}

/**
 * What an image really is, read from its leading bytes.
 *
 * The type a browser declares for an upload is whatever the client says, so it
 * is never consulted. Only the three formats a photo can sensibly be are
 * recognised; SVG (which can carry script), GIF, HTML and anything too short to
 * carry a signature all come back null.
 */
export function sniffImageType(bytes: Uint8Array): AvatarImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  // RIFF....WEBP: bytes 4 to 7 are the chunk size and can be anything.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return null
}

/**
 * The same-origin url for a user's photo, or null when they have none.
 *
 * The version parameter is the time the photo last changed, so the route can
 * let the browser cache a versioned url for a year and a new photo still shows
 * the moment it is saved.
 */
export function avatarSrc(userId: string, avatarUpdatedAt: string | null): string | null {
  if (!avatarUpdatedAt) return null
  const ms = new Date(avatarUpdatedAt).getTime()
  if (Number.isNaN(ms)) return null
  return `/api/avatar/${encodeURIComponent(userId)}?v=${ms}`
}

/** The first letter or digit in a word, uppercased, or '' when it has none.
 *  A character counts as a letter when it has distinct cases, which covers
 *  accented Latin names (Ondrej, Zofia with diacritics) without a Unicode
 *  property regex the ES2017 target cannot compile. */
function firstLetter(word: string): string {
  for (const ch of word) {
    if (ch.toUpperCase() !== ch.toLowerCase() || (ch >= '0' && ch <= '9')) return ch.toUpperCase()
  }
  return ''
}

/**
 * One or two letters to stand in for a photo.
 *
 * "Dean Jeggels" gives DJ, "juraj" gives J. With no name, the part of the email
 * before the @ is used, split on dots, dashes and underscores, so
 * dean.jeggels@example.com also gives DJ. With nothing at all, "?".
 */
export function initialsFor(name: string | null | undefined, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0].trim()
  const words = source.split(/[\s._-]+/).filter((w) => firstLetter(w) !== '')
  if (words.length === 0) return '?'
  if (words.length === 1) return firstLetter(words[0])
  return firstLetter(words[0]) + firstLetter(words[words.length - 1])
}
