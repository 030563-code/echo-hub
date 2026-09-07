import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runMrpEngine } from "@/lib/mrp/engine";
import { createSupabaseEngineData } from "@/lib/mrp/engine-data";

// ---------------------------------------------------------------------------
// POST /api/mrp/run — the nightly MRP engine trigger (n8n cron → here).
//
// Auth: `authorization: Bearer ${MRP_CRON_SECRET}` — a machine secret, not a
// user session (the engine writes with the service role; no capability model
// applies). Fails CLOSED: a missing/empty MRP_CRON_SECRET rejects every
// request rather than ever running open. Comparison is constant-time over
// sha256 digests so neither length nor prefix leaks.
//
// POST only (no GET — the run mutates status/spike/profile tables). Response
// is the run summary; per-SKU rows live in mrp_buffer_status_daily.
// ---------------------------------------------------------------------------

function authorized(header: string | null): boolean {
  const secret = process.env.MRP_CRON_SECRET;
  if (!secret) return false;
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const got = createHash("sha256").update(header ?? "").digest();
  return timingSafeEqual(expected, got);
}

export async function POST(request: Request) {
  if (!authorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const result = await runMrpEngine(createSupabaseEngineData(admin));
    return NextResponse.json({
      run_date: result.run_date,
      skus: result.skus,
      reds: result.reds,
      yellows: result.yellows,
      greens: result.greens,
      blocked: result.blocked,
      warnings: result.warnings,
    });
  } catch (e) {
    console.error("MRP engine run failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "engine run failed" }, { status: 500 });
  }
}
