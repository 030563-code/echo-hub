import { INVOICE_STAGES } from '@/lib/customer-invoice/constants'
import { InvoiceStageQueue } from '../stage-queue'

export const dynamic = 'force-dynamic'

const STAGE = INVOICE_STAGES.find((s) => s.status === 'tax_calculated')!

export default function Page() {
  return <InvoiceStageQueue stage={STAGE} />
}
