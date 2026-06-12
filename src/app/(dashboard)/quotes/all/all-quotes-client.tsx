'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle, Filter } from 'lucide-react'
import Link from 'next/link'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { PaginationNav } from '@/components/ui/pagination-nav'

interface HubSpotDeal {
  id: string
  properties: {
    dealname: string
    amount: string | null
    createdate: string
    dealstage: string
    pipeline: string
  }
}

interface AllQuotesClientProps {
  initialDeals: HubSpotDeal[]
  error?: string
  probabilityMap: Record<string, number | null>
  currentPage: number
  hasNextPage: boolean
  cursorStack: string
  nextAfter?: string
}

export default function AllQuotesClient({ initialDeals, error, probabilityMap, currentPage, hasNextPage, cursorStack, nextAfter }: AllQuotesClientProps) {
  const deals = initialDeals
  const [selectedPipeline, setSelectedPipeline] = useState<string>('all')
  const [selectedStage, setSelectedStage] = useState<string>('all')

  // Flatten pipelines for easier lookup
  const pipelines = Object.values(HUBSPOT_PIPELINES)

  // Derive filtered deals during render (React Compiler handles memoization) instead
  // of storing in state via an effect, which would cascade an extra render pass.
  const isFiltered = selectedPipeline !== 'all' || selectedStage !== 'all'
  const filteredDeals = deals.filter((deal) => {
    if (selectedPipeline !== 'all' && deal.properties.pipeline !== selectedPipeline) return false
    if (selectedStage !== 'all' && deal.properties.dealstage !== selectedStage) return false
    return true
  })

  // Helper to get stage label
  const getStageLabel = (pipelineId: string, stageId: string) => {
    const pipeline = pipelines.find(p => p.id === pipelineId)
    if (!pipeline) return stageId
    
    const stageEntry = Object.entries(pipeline.stages).find(([, id]) => id === stageId)
    return stageEntry ? stageEntry[0].replace(/_/g, ' ') : stageId
  }

  // Helper to get pipeline label
  const getPipelineLabel = (pipelineId: string) => {
    const pipeline = pipelines.find(p => p.id === pipelineId)
    return pipeline ? pipeline.label : pipelineId
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Quotes</h1>
          <p className="text-gray-500 text-sm mt-1">View and filter all your deals across pipelines.</p>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4 bg-white border-gray-200">
        <div className="flex flex-col md:flex-row gap-4 items-end md:items-center">
          <div className="w-full md:w-64">
            <label className="text-xs font-bold text-gray-500 uppercase mb-1 block">Pipeline</label>
            <Select value={selectedPipeline} onValueChange={(val) => { setSelectedPipeline(val); setSelectedStage('all'); }}>
              <SelectTrigger className="bg-white border-gray-300 text-gray-900">
                <SelectValue placeholder="All Pipelines" />
              </SelectTrigger>
              <SelectContent className="bg-white border-gray-200 text-gray-900">
                <SelectItem value="all">All Pipelines</SelectItem>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-full md:w-64">
            <label className="text-xs font-bold text-gray-500 uppercase mb-1 block">Stage</label>
            <Select value={selectedStage} onValueChange={setSelectedStage} disabled={selectedPipeline === 'all'}>
              <SelectTrigger className="bg-white border-gray-300 text-gray-900">
                <SelectValue placeholder="All Stages" />
              </SelectTrigger>
              <SelectContent className="bg-white border-gray-200 text-gray-900">
                <SelectItem value="all">All Stages</SelectItem>
                {selectedPipeline !== 'all' && pipelines.find(p => p.id === selectedPipeline)?.stages && 
                  Object.entries(pipelines.find(p => p.id === selectedPipeline)!.stages).map(([key, id]) => (
                    <SelectItem key={id} value={id}>{key.replace(/_/g, ' ')}</SelectItem>
                  ))
                }
              </SelectContent>
            </Select>
          </div>
          
          <div className="pb-1 text-sm text-gray-500">
            {isFiltered
              ? `Showing ${filteredDeals.length} of ${deals.length} deals on this page`
              : `Showing ${filteredDeals.length} deals`}
          </div>
        </div>
      </Card>

      {error ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading quotes</p>
          </div>
          <p className="text-red-600 text-sm mt-1 ml-8">{error}</p>
        </Card>
      ) : filteredDeals.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-black text-white uppercase text-xs tracking-wider">
              <tr>
                <th className="px-6 py-4 font-medium">Deal Name</th>
                <th className="px-6 py-4 font-medium">Pipeline</th>
                <th className="px-6 py-4 font-medium">Created Date</th>
                <th className="px-6 py-4 font-medium text-right">Amount</th>
                <th className="px-6 py-4 font-medium text-center">Stage</th>
                <th className="px-6 py-4 font-medium text-right">Probability</th>
                <th className="px-6 py-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredDeals.map((deal) => (
                <tr key={deal.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900">
                    {deal.properties.dealname}
                  </td>
                  <td className="px-6 py-4 text-gray-500 text-xs">
                    {getPipelineLabel(deal.properties.pipeline)}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(deal.properties.createdate).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric'
                    })}
                  </td>
                  <td className="px-6 py-4 text-right font-mono text-gray-700">
                    {deal.properties.amount 
                      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(deal.properties.amount))
                      : '-'
                    }
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200">
                      {getStageLabel(deal.properties.pipeline, deal.properties.dealstage)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className="text-xs text-gray-500 font-mono">
                      {probabilityMap[deal.id] != null ? `${probabilityMap[deal.id]}%` : '—'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link href={`/quotes/requests/${deal.id}`}>
                      <Button variant="outline" size="sm" className="text-xs h-8">
                        View Details
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-lg border-dashed">
          <div className="mx-auto h-12 w-12 text-gray-300 mb-3">
            <Filter className="w-full h-full" />
          </div>
          <h3 className="text-lg font-medium text-gray-900">No quotes found</h3>
          <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">
            Try adjusting your filters or check back later.
          </p>
        </div>
      )}

      {/* The pipeline/stage filter only operates on the currently loaded page, while
          paging is cursor-based on the full server-side set. Showing pagination during a
          filter would let a user "page" filtered-only views and produce misleading results,
          so we hide it while a filter is active and keep the count label honest above. */}
      {!isFiltered && filteredDeals.length > 0 && (
        <PaginationNav
          currentPage={currentPage}
          hasNextPage={hasNextPage}
          basePath="/quotes/all"
          cursorStack={cursorStack}
          nextAfter={nextAfter}
        />
      )}
    </div>
  )
}
