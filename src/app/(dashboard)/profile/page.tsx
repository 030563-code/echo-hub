import { redirect } from 'next/navigation'
import { getAuthorizedUser } from '@/lib/authz'
import { loadOwnProfile } from '@/lib/profile/load-own-profile'
import ProfileForm from './profile-form'

export const dynamic = 'force-dynamic'

/**
 * Your profile: a job title, a bio and a photo.
 *
 * Open to every signed-in user. There is no capability check beyond the
 * session the dashboard layout already enforces, because everything on this
 * page is the person's own and every write acts on the session user only.
 */
export default async function ProfilePage() {
  const auth = await getAuthorizedUser()
  if (!auth.ok) redirect('/login')

  const profile = await loadOwnProfile(auth.user.id)
  if (!profile) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Your profile
        </h1>
        <p className="text-sm text-gray-600 mt-2">
          Your profile could not be loaded. Refresh the page to try again.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Your profile
        </h1>
        <p className="text-gray-500 text-sm mt-1">Your photo, job title and bio.</p>
      </div>

      <ProfileForm
        userId={auth.user.id}
        email={auth.user.email ?? null}
        displayName={profile.displayName}
        jobTitle={profile.jobTitle}
        bio={profile.bio}
        avatarUpdatedAt={profile.avatarUpdatedAt}
      />
    </div>
  )
}
