import { createMfgClient } from "@/lib/supabase/mfg";
import BomClient, { type BomRow } from "./bom-client";

export const dynamic = "force-dynamic";

// Latest-week BOM cost per model from the mfg project. Reads the most recent
// week_start_date snapshot. Degrades gracefully if the mfg keys aren't configured
// yet (Dean provides MFG_SUPABASE_URL + MFG_SUPABASE_SERVICE_ROLE_KEY).
async function loadLatestBom(): Promise<{ rows: BomRow[]; week: string | null; error?: string }> {
  if (!process.env.MFG_SUPABASE_URL || !process.env.MFG_SUPABASE_SERVICE_ROLE_KEY) {
    return { rows: [], week: null, error: "Manufacturing data source not configured (MFG_SUPABASE_* env)." };
  }
  try {
    const mfg = createMfgClient();
    const { data: latest } = await mfg
      .from("bom_weekly_snapshot")
      .select("week_start_date")
      .order("week_start_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const week = latest?.week_start_date ?? null;
    if (!week) return { rows: [], week: null };

    const { data, error } = await mfg
      .from("bom_weekly_snapshot")
      .select(
        "model_code, product_line, bamida_total_eur, sro_total_eur, bom_total_eur, bom_change_eur, bom_change_pct, fx_gbp_eur"
      )
      .eq("week_start_date", week)
      .order("model_code");

    if (error) return { rows: [], week, error: "Failed to load BOM snapshot." };
    return { rows: (data ?? []) as BomRow[], week };
  } catch {
    return { rows: [], week: null, error: "Failed to reach the manufacturing data source." };
  }
}

export default async function BomPage() {
  const { rows, week, error } = await loadLatestBom();

  const rising = rows.filter((r) => (r.bom_change_pct ?? 0) > 0).length;
  const falling = rows.filter((r) => (r.bom_change_pct ?? 0) < 0).length;
  const totalBom = rows.reduce((s, r) => s + (r.bom_total_eur ?? 0), 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
          Bill of Materials &amp; Pricing
        </h1>
        <p className="text-[#6b7280] text-sm mt-1">
          Manufacturing cost per model{week ? ` — week of ${week}` : ""}. Week-over-week change flags input-cost moves (e.g. PVC).
        </p>
      </div>

      {error ? (
        <div className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-5 py-8 text-center text-[#9ca3af] text-sm">
          {error}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { label: "Models", value: rows.length, color: "text-white" },
              { label: "Total BOM (€)", value: Math.round(totalBom).toLocaleString(), color: "text-[#FF7026]" },
              { label: "Cost Rising", value: rising, color: rising > 0 ? "text-red-300" : "text-emerald-300" },
              { label: "Cost Falling", value: falling, color: "text-emerald-300" },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
                <p className="text-[#6b7280] text-xs mb-0.5">{label}</p>
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
              </div>
            ))}
          </div>
          <BomClient rows={rows} />
        </>
      )}
    </div>
  );
}
