import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import type { QuoteSentStore } from './run'

/**
 * Where the quote-sent check keeps its record: quote_sent_check_runs and quote_sent_moves
 * (migration 20260924235000), both service role only.
 */

export function supabaseQuoteSentStore(admin: SupabaseClient = createAdminClient()): QuoteSentStore {
  return {
    async lastCleanMoveRunEnd() {
      const { data, error } = await admin
        .from('quote_sent_check_runs')
        .select('window_to')
        .eq('mode', 'move')
        .not('finished_at', 'is', null)
        .is('error', null)
        .order('window_to', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`quote_sent_check_runs: ${error.message}`)
      return data ? new Date((data as { window_to: string }).window_to) : null
    },

    async startRun({ mode, from, to }) {
      const { data, error } = await admin
        .from('quote_sent_check_runs')
        .insert({ mode, window_from: from.toISOString(), window_to: to.toISOString() })
        .select('id')
        .single()
      if (error || !data) throw new Error(`quote_sent_check_runs: ${error?.message ?? 'no row'}`)
      return (data as { id: number }).id
    },

    async record(row) {
      const { error } = await admin.from('quote_sent_moves').insert({
        run_id: row.runId,
        hubspot_deal_id: row.dealId,
        pipeline_id: row.pipelineId,
        from_stage: row.fromStage,
        to_stage: row.toStage,
        hubspot_quote_id: row.quoteId,
        hubspot_email_id: row.emailId,
        email_sent_at: row.emailSentAt,
        outcome: row.outcome,
        error: row.error ?? null,
      })
      if (error) throw new Error(`quote_sent_moves: ${error.message}`)
    },

    async finishRun(runId, result) {
      const { error } = await admin
        .from('quote_sent_check_runs')
        .update({
          finished_at: new Date().toISOString(),
          emails_read: result.emailsRead,
          deals_checked: result.dealsChecked,
          moved: result.moved,
          would_move: result.wouldMove,
          failed: result.failed,
          notes: result.notes,
          error: result.error,
        })
        .eq('id', runId)
      if (error) throw new Error(`quote_sent_check_runs: ${error.message}`)
    },
  }
}

export interface QuoteSentMoveNote {
  movedAt: string
  emailSentAt: string
  toStage: string
}

/** The latest time the check moved this deal, for the deal page. Null when it never has. */
export async function latestQuoteSentMove(admin: SupabaseClient, dealId: string): Promise<QuoteSentMoveNote | null> {
  const { data } = await admin
    .from('quote_sent_moves')
    .select('created_at, email_sent_at, to_stage')
    .eq('hubspot_deal_id', dealId)
    .eq('outcome', 'moved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const row = data as { created_at: string; email_sent_at: string; to_stage: string }
  return { movedAt: row.created_at, emailSentAt: row.email_sent_at, toStage: row.to_stage }
}
