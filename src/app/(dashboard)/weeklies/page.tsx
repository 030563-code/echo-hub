import { createServerClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/authz'
import WeekliesClient, { type WeeklyItem } from './weeklies-client'

export const dynamic = 'force-dynamic'

/** ISO date (YYYY-MM-DD) of the Monday on or before `d`. */
function mondayOf(d: Date): string {
  const diff = (d.getDay() + 6) % 7 // days since Monday (0=Sun..6=Sat → Mon=0)
  const monday = new Date(d)
  monday.setDate(d.getDate() - diff)
  return monday.toISOString().slice(0, 10)
}

export default async function WeekliesPage() {
  const weekStart = mondayOf(new Date())
  const supabase = await createServerClient()
  const canEdit = await hasCapability('weeklies.edit')

  let items: WeeklyItem[] = []
  let notProvisioned = false
  try {
    const { data, error } = await supabase
      .from('weekly_items')
      .select('*')
      .eq('week_start_date', weekStart)
      .order('created_at', { ascending: true })
    if (error) notProvisioned = true
    else items = (data ?? []) as WeeklyItem[]
  } catch {
    notProvisioned = true
  }

  return (
    <WeekliesClient weekStart={weekStart} items={items} canEdit={canEdit} notProvisioned={notProvisioned} />
  )
}
