import 'server-only'

import { createServerClient } from '@/lib/supabase/server'

/**
 * What a person has said about themselves: the fields /profile edits, and the
 * ones the header and sidebar show.
 *
 * Read through the SESSION client, so RLS decides. Pass the id from
 * getAuthorizedUser(), never one that came from a request.
 */
export interface OwnProfile {
  displayName: string | null
  jobTitle: string | null
  bio: string | null
  /** Null means no photo. Feed it to avatarSrc(). */
  avatarUpdatedAt: string | null
}

export async function loadOwnProfile(userId: string): Promise<OwnProfile | null> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, job_title, bio, avatar_updated_at')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  return {
    displayName: data.display_name ?? null,
    jobTitle: data.job_title ?? null,
    bio: data.bio ?? null,
    avatarUpdatedAt: data.avatar_updated_at ?? null,
  }
}
