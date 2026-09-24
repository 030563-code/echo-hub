"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthorizedUser } from "@/lib/authz";
import { latestBomModels } from "@/lib/bom";

// ---------------------------------------------------------------------------
// Bamida's manufacturing and printing price per model, set in the Hub
// (bom_bamida_price). They win over the prices the weekly sync copies from
// Dave's sheet, which would overwrite anything typed into the snapshot itself.
// bom.edit + cost.view gated; service-role write after the gate; audited to ops
// bom_edit_log (model_code = the model). Orders approved from then on freeze
// with the new prices; one approved already keeps its cost until re-costed.
// ---------------------------------------------------------------------------

// A number sets the Hub's price, null hands that part back to the sheet, and a
// part left out stays as it is.
const Price = z.number().nonnegative().max(100_000).nullable().optional();

const Schema = z.object({
  edits: z
    .array(
      z.object({
        model_code: z.string().trim().min(1).max(60),
        manufacturing_eur: Price,
        printing_eur: Price,
      }),
    )
    .min(1, "Nothing to save")
    .max(100)
    .refine((edits) => new Set(edits.map((e) => e.model_code)).size === edits.length, "A model appears twice"),
});

export type SaveBamidaPricesInput = z.infer<typeof Schema>;
export type SaveBamidaPricesResult = { success: true; updated: number; failed: number } | { success: false; error: string };

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

interface Stored {
  manufacturing_eur: number | null;
  printing_eur: number | null;
}

const stored = (v: unknown): number | null => (v == null ? null : Number(v));

export async function saveBamidaPrices(input: SaveBamidaPricesInput): Promise<SaveBamidaPricesResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("bom.edit") || !auth.capabilities.has("cost.view")) {
    return { success: false, error: "Forbidden: setting Bamida prices needs bom.edit and cost.view" };
  }

  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const edits = parsed.data.edits;
  const admin = createAdminClient();

  let week: string | null;
  const beforeByModel = new Map<string, Stored>();
  try {
    const bom = await latestBomModels();
    week = bom.week;
    const unknown = edits.find((e) => !bom.models.has(e.model_code));
    if (unknown) return { success: false, error: `The bill of materials has no model called ${unknown.model_code}.` };

    const { data, error } = await admin
      .from("bom_bamida_price")
      .select("model_code, manufacturing_eur, printing_eur")
      .in("model_code", edits.map((e) => e.model_code));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { model_code: string; manufacturing_eur: unknown; printing_eur: unknown }[]) {
      beforeByModel.set(r.model_code, { manufacturing_eur: stored(r.manufacturing_eur), printing_eur: stored(r.printing_eur) });
    }
  } catch (e) {
    console.error("saveBamidaPrices could not read", e);
    return { success: false, error: "Could not read the prices to change." };
  }

  const label = auth.user.email ?? "Hub user";
  const nowIso = new Date().toISOString();
  const committed: { model_code: string; before: Stored; after: Stored }[] = [];
  let failed = 0;

  for (const e of edits) {
    const before = beforeByModel.get(e.model_code) ?? { manufacturing_eur: null, printing_eur: null };
    const part = (typed: number | null | undefined, was: number | null) =>
      typed === undefined ? was : typed === null ? null : round4(typed);
    const after: Stored = {
      manufacturing_eur: part(e.manufacturing_eur, before.manufacturing_eur),
      printing_eur: part(e.printing_eur, before.printing_eur),
    };
    if (after.manufacturing_eur === before.manufacturing_eur && after.printing_eur === before.printing_eur) continue;

    // Both parts back to the sheet: no row at all, rather than a row that says nothing.
    const { error } =
      after.manufacturing_eur === null && after.printing_eur === null
        ? await admin.from("bom_bamida_price").delete().eq("model_code", e.model_code)
        : await admin
            .from("bom_bamida_price")
            .upsert(
              { model_code: e.model_code, ...after, updated_by: auth.user.id, updated_by_label: label, updated_at: nowIso },
              { onConflict: "model_code" },
            );
    if (error) {
      console.error("saveBamidaPrices failed", e.model_code, error.message);
      failed++;
      continue;
    }
    committed.push({ model_code: e.model_code, before, after });
  }

  // The trail records only what committed. Null means the sheet's price applies.
  if (committed.length) {
    const { error } = await admin.from("bom_edit_log").insert(
      committed.map((c) => ({
        model_code: c.model_code,
        week_start_date: week,
        edited_by: auth.user.id,
        edited_by_label: label,
        before: { bamida_price_in_hub: c.before },
        after: { bamida_price_in_hub: c.after },
      })),
    );
    if (error) console.error("bom_edit_log insert (Bamida price) failed", error.message);
  }

  revalidatePath("/bom");
  if (failed && committed.length === 0) return { success: false, error: "Could not save the prices." };
  return { success: true, updated: committed.length, failed };
}
