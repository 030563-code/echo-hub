import "server-only";
import { createMfgClient } from "@/lib/supabase/mfg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FxRates } from "@/lib/po-currency";
import type { PdfParty } from "@/lib/po-pdf";

// Server-side inputs for the PO PDF: the From/To party addresses (entities +
// depots + the Bamida supplier) and the weekly FX rates used to convert costs
// into each leg's currency. Built once on the PO page and passed to the client.

export interface PoPdfData {
  parties: Record<string, PdfParty>;
  fx: FxRates | null;
}

function splitAddr(a: string | null | undefined): string[] {
  if (!a) return [];
  const raw = a.includes("\n") ? a.split("\n") : a.split(",");
  return raw.map((s) => s.trim()).filter((s) => s && !/confirm/i.test(s));
}

export async function getPoPdfData(supabase: SupabaseClient): Promise<PoPdfData> {
  const [{ data: entities }, { data: depots }, { data: suppliers }] = await Promise.all([
    supabase.from("entities").select("code, legal_name, address_lines"),
    supabase.from("po_delivery_addresses").select("entity, label, address"),
    supabase.from("po_suppliers").select("name, address"),
  ]);

  const parties: Record<string, PdfParty> = {};
  for (const e of (entities ?? []) as { code: string; legal_name: string; address_lines: string[] | null }[]) {
    parties[e.code] = { name: e.legal_name, lines: e.address_lines ?? [] };
  }

  const usa = parties["EB-USA"];
  for (const d of (depots ?? []) as { entity: string; label: string | null; address: string | null }[]) {
    const lines = splitAddr(d.address);
    if (d.entity.startsWith("US-")) {
      // US depots ARE Echo Barrier USA LLC; prefer a real depot address, else the entity's.
      parties[d.entity] = { name: usa?.name ?? "Echo Barrier USA LLC", lines: lines.length ? lines : usa?.lines ?? [] };
    } else if (d.entity.startsWith("CA-")) {
      parties[d.entity] = { name: "Echo Barrier Canada Inc", lines };
    } else if (!parties[d.entity]) {
      parties[d.entity] = { name: d.label ?? d.entity, lines };
    }
  }

  // The SRO→Supplier leg's "SUPPLIER" is the Bamida manufacturer.
  const bamida = ((suppliers ?? []) as { name: string; address: string | null }[]).find(
    (s) => /bamida/i.test(s.name) && s.address
  );
  parties["SUPPLIER"] = bamida
    ? { name: bamida.name, lines: splitAddr(bamida.address) }
    : { name: "Bamida s.r.o.", lines: ["Kosicka 28", "080 01 Presov", "Slovakia"] };

  // Weekly FX (latest per pair) for USD↔GBP↔EUR conversion.
  let fx: FxRates | null = null;
  try {
    const mfg = createMfgClient();
    const { data: fxRows } = await mfg
      .from("fx_weekly")
      .select("pair, avg_rate, week_start_date")
      .in("pair", ["EUR_USD", "GBP_EUR", "EUR_CAD"])
      .order("week_start_date", { ascending: false });
    const latest: Record<string, number> = {};
    for (const r of (fxRows ?? []) as { pair: string; avg_rate: number | string }[]) {
      if (latest[r.pair] === undefined) latest[r.pair] = Number(r.avg_rate);
    }
    if (latest.EUR_USD && latest.GBP_EUR && latest.EUR_CAD) {
      fx = { EUR_USD: latest.EUR_USD, GBP_EUR: latest.GBP_EUR, EUR_CAD: latest.EUR_CAD };
    }
  } catch {
    fx = null; // FX is optional — the PDF still renders (no conversion).
  }

  return { parties, fx };
}
