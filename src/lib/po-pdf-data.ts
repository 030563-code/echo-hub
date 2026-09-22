import "server-only";
import { createMfgClient } from "@/lib/supabase/mfg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FxRates } from "@/lib/po-currency";
import type { PdfParty } from "@/lib/po-pdf";
import { orgForDepot } from "@/lib/organisations";

// Server-side inputs for the PO PDF: the From/To party addresses (entities +
// depots + the Bamida supplier) and the weekly FX rates used to convert costs
// into each leg's currency. Built once on the PO page and passed to the client.

export interface PoPdfData {
  parties: Record<string, PdfParty>;
  fx: FxRates | null;
}

/** An address line nobody has filled in yet ("Confirm registered address",
 *  "— confirm ship-to address —") is a note to ourselves, and this document is
 *  read outside the company. Drop it rather than print it. */
function realLines(lines: readonly string[]): string[] {
  return lines.map((s) => s.trim()).filter((s) => s && !/confirm/i.test(s));
}

/** Some ship-to rows are newline-separated, some comma-separated, and the Bury
 *  St Edmunds one is comma-separated with a trailing newline, which used to
 *  count as "has newlines" and print the whole address on a single line. Take
 *  the newlines when there are two real ones, otherwise the commas. */
function splitAddr(a: string | null | undefined): string[] {
  if (!a) return [];
  const byLine = realLines(a.split("\n"));
  return byLine.length > 1 ? byLine : realLines((byLine[0] ?? "").split(","));
}

export async function getPoPdfData(supabase: SupabaseClient): Promise<PoPdfData> {
  const [{ data: entities }, { data: depots }, { data: suppliers }] = await Promise.all([
    supabase.from("entities").select("code, legal_name, address_lines"),
    supabase.from("po_delivery_addresses").select("entity, label, address"),
    supabase.from("po_suppliers").select("name, address"),
  ]);

  const parties: Record<string, PdfParty> = {};
  for (const e of (entities ?? []) as { code: string; legal_name: string; address_lines: string[] | null }[]) {
    parties[e.code] = { name: e.legal_name, lines: realLines(e.address_lines ?? []) };
  }

  // A depot is not a legal party. The first leg of every chain is raised BY a
  // depot code (US-BAL, EU-FR, GB-BSE), but the company placing the order is
  // the one that owns the depot, so the From block carries that company's legal
  // name. Its street address is the better line to print when it has one, since
  // that is where the goods actually sit; the registered address stands in when
  // it does not.
  //
  // Dean, 22 Sep 2026: "does the addresses on the POs for the different regions
  // also carry across on the PO documents and not just hardcoded to US?" They
  // did not. USA and Canada were named here by hand and every other region fell
  // through to the delivery-address label, so a French order was placed by
  // "France depot" and a British one by "UK depot, Bury St Edmunds". The
  // depot-to-organisation map already existed; this reads it instead.
  for (const d of (depots ?? []) as { entity: string; label: string | null; address: string | null }[]) {
    const lines = splitAddr(d.address);
    const owner = parties[orgForDepot(d.entity) ?? ""];
    if (owner) {
      parties[d.entity] = { name: owner.name, lines: lines.length ? lines : owner.lines };
    } else if (!parties[d.entity]) {
      // Not a depot of any organisation (EB-GROUP and EB-SRO have ship-to rows
      // of their own). Their entity row already won above; this is the last
      // resort for a code nobody has mapped.
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
