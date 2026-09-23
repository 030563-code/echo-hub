import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { bearerAuthorized } from '@/lib/machine-auth'
import { syncAllCargo } from '@/lib/cargo/sync'

// ---------------------------------------------------------------------------
// POST /api/cargo/refresh: the scheduled Cargo Partner refresh (n8n schedule on medes, here).
//
// Until 23 Sep 2026 the board only moved when somebody pressed Refresh; it had last done so the
// day before. This refreshes every shipment still under way (a finished journey does not change)
// with the same read the button makes. Nothing is written to Cargo Partner.
//
// Auth: `authorization: Bearer ${CARGO_REFRESH_SECRET}`. Fails CLOSED: with the secret unset
// every request is refused. The answer carries counts only.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!bearerAuthorized(request.headers.get('authorization'), process.env.CARGO_REFRESH_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const result = await syncAllCargo({ onlyOpen: true })
    revalidatePath('/transport')
    return NextResponse.json({ attempted: result.attempted, synced: result.synced, failed: result.failed.length })
  } catch (e) {
    console.error('scheduled cargo refresh failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'refresh failed' }, { status: 500 })
  }
}
