'use server'

import { createServerClient } from '@/lib/supabase/server'

export interface SalesProfileSettings {
  allowed_distributors: string[]
  allowed_depots: string[]
  allowed_quote_templates: string[]
}

export async function getSalesProfileSettings(): Promise<{ success: boolean; data?: SalesProfileSettings; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('allowed_distributors, allowed_depots, allowed_quote_templates')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('Error fetching profile settings:', error)
    return { success: false, error: 'Failed to load user profile settings' }
  }

  if (!profile) {
    return { success: false, error: 'User profile not found' }
  }

  return {
    success: true,
    data: {
      allowed_distributors: profile.allowed_distributors || [],
      allowed_depots: profile.allowed_depots || [],
      allowed_quote_templates: profile.allowed_quote_templates || []
    }
  }
}
