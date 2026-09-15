import { Building2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { orgLabel, type OrgCode } from '@/lib/organisations'

/**
 * What a scoped page shows instead of data when there is no organisation to
 * scope it to.
 *
 * Two cases, both said plainly. No organisation at all: the person holds
 * none, so an administrator has to grant one. An organisation the module has
 * nothing for (France holds no stock): nothing is hidden, there is nothing.
 * Neither ever falls back to showing everything.
 */
export function NoOrganisationCard({
  title,
  what,
  org,
}: {
  /** The page heading, kept so the page still says where the person is. */
  title: string
  /** What would be listed here: "accepted quotes", "prices", "stock". */
  what: string
  /** Set when the person holds an organisation but the module has nothing for it. */
  org?: OrgCode | null
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      <Card className="bg-white border-gray-200 p-10 text-center text-gray-500">
        <Building2 className="w-8 h-8 mx-auto mb-3 text-gray-300" />
        {org ? (
          <>
            <p className="font-medium text-gray-700">Nothing here for {orgLabel(org)}</p>
            <p className="text-sm mt-1">
              {orgLabel(org)} has no {what} in the Hub. Pick another organisation in the sidebar.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-gray-700">No organisation is assigned to you</p>
            <p className="text-sm mt-1">
              An administrator needs to grant you an organisation before {what} can be shown.
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
