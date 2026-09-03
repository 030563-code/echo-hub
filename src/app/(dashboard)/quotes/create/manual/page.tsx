import CreateManualRequestForm from './create-manual-form'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { requireCapability, getAuthorizedUser } from '@/lib/authz'
import { allowedCurrenciesForPipeline } from '@/lib/pipeline-config'

export default async function CreateManualRequestPage() {
  await requireCapability('quotes.create')
  const auth = await getAuthorizedUser()
  const restrictedToOwn = auth.ok ? !auth.profile.is_super_admin : true
  // Resolved here so the pipeline id stays server-side.
  const allowedCurrencies = allowedCurrenciesForPipeline(auth.ok ? auth.profile.pipeline_id : null)
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/quotes/deals">
          <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-900">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Deals
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Create Deal</h1>
      </div>

      <CreateManualRequestForm
        restrictedToOwn={restrictedToOwn}
        allowedCurrencies={allowedCurrencies}
        defaultCurrency={allowedCurrencies[0]}
      />
    </div>
  )
}
