import CreateManualRequestForm from './create-manual-form'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { requireCapability } from '@/lib/authz'

export default async function CreateManualRequestPage() {
  await requireCapability('quotes.create')
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/quotes/requests">
          <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-900">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Requests
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Create Manual Request</h1>
      </div>

      <CreateManualRequestForm />
    </div>
  )
}
