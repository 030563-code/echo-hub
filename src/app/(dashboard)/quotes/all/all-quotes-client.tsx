'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle, Filter } from 'lucide-react'
import { HUBSPOT_PIPELINES, stageLabel } from '@/lib/hubspot-constants'
import { PaginationNav } from '@/components/ui/pagination-nav'
import { DealList } from '@/components/quotes/deal-list'
import type { HubSpotDeal } from '@/lib/hubspot-types'
import { formatMoney } from '@/lib/utils'


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

  // Both fallbacks here used to return the raw stage id, so a deal whose
  // pipeline was not in the constants rendered a 36-character GUID at the rep.
  // stageLabel resolves through every pipeline before giving up.
  const getStageLabel = (pipelineId: string, stageId: string) => stageLabel(pipelineId, stageId)

  // Helper to get pipeline label
  const getPipelineLabel = (pipelineId: string) => {
    const pipeline = pipelines.find(p => p.id === pipelineId)
    return pipeline ? pipeline.label : pipelineId
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                  Object.entries(pipelines.find(p => p.id === selectedPipeline)!.stages).map(([, id]) => (
                    <SelectItem key={id} value={id}>{stageLabel(selectedPipeline, id)}</SelectItem>
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
        <DealList
          dateHeader="Created Date"
          badgeHeader="Stage"
          pipelineHeader="Pipeline"
          probabilityHeader="Probability"
          rows={filteredDeals.map((deal) => ({
            id: deal.id,
            name: deal.properties.dealname,
            pipelineLabel: getPipelineLabel(deal.properties.pipeline),
            dateValue: new Date(deal.properties.createdate).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            }),
            amountFormatted: deal.properties.amount
              ? formatMoney(Number(deal.properties.amount), deal.properties.deal_currency_code ?? 'USD')
              : '-',
            badge: {
              text: getStageLabel(deal.properties.pipeline, deal.properties.dealstage),
              className: 'bg-gray-100 text-gray-800 border-gray-200',
            },
            probabilityLabel: probabilityMap[deal.id] != null ? `${probabilityMap[deal.id]}%` : '\u2014',
            action: { href: `/quotes/deals/${deal.id}`, label: 'View Details' },
          }))}
        />
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
