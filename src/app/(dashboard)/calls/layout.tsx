import { requireCapability } from '@/lib/authz'
import { CallsNav } from './calls-nav'

export default async function CallsLayout({ children }: { children: React.ReactNode }) {
  await requireCapability('calls.view')

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Calls
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Every call the phone system took for your offices, with what was said, and the contacts it
          created from a number alone. Linking one of those to the contact you created merges the two
          in HubSpot: your contact keeps its name and email, gains the phone number, and the call
          moves onto it.
        </p>
      </div>
      <CallsNav />
      {children}
    </div>
  )
}
