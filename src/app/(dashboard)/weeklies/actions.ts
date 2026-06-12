'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createServerClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/authz'

type Result = { success: true } | { error: string }

const AddSchema = z.object({
  week_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid week'),
  day: z.enum(['mon', 'tue', 'wed']),
  title: z.string().trim().min(1, 'Title required').max(200),
  owner: z.string().trim().max(100).optional(),
})

export async function addWeeklyItem(input: z.infer<typeof AddSchema>): Promise<Result> {
  if (!(await hasCapability('weeklies.edit'))) return { error: 'Forbidden: missing weeklies.edit' }
  const parsed = AddSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input' }

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const { error } = await supabase.from('weekly_items').insert({
    week_start_date: parsed.data.week_start_date,
    day: parsed.data.day,
    title: parsed.data.title,
    owner: parsed.data.owner || null,
    created_by: user.id,
  })
  if (error) return { error: 'Failed to add item' }
  revalidatePath('/weeklies')
  return { success: true }
}

const StatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['todo', 'doing', 'done']),
})

export async function setWeeklyItemStatus(id: string, status: 'todo' | 'doing' | 'done'): Promise<Result> {
  if (!(await hasCapability('weeklies.edit'))) return { error: 'Forbidden: missing weeklies.edit' }
  const parsed = StatusSchema.safeParse({ id, status })
  if (!parsed.success) return { error: 'Invalid input' }

  const supabase = await createServerClient()
  const { error } = await supabase
    .from('weekly_items')
    .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
  if (error) return { error: 'Failed to update item' }
  revalidatePath('/weeklies')
  return { success: true }
}

export async function deleteWeeklyItem(id: string): Promise<Result> {
  if (!(await hasCapability('weeklies.edit'))) return { error: 'Forbidden: missing weeklies.edit' }
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return { error: 'Invalid id' }

  const supabase = await createServerClient()
  const { error } = await supabase.from('weekly_items').delete().eq('id', parsed.data)
  if (error) return { error: 'Failed to delete item' }
  revalidatePath('/weeklies')
  return { success: true }
}
