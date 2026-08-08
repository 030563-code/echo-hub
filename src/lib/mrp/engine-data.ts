import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BomComponentRow,
  BomProductRow,
  BomSkuMapRow,
  DealRow,
  DemandEventRow,
  EngineData,
  MaterialStockRow,
  OpenPoLineRow,
  ProfileRow,
  ProfileWriteBack,
  ReceiptRow,
  ShipmentRow,
  SpikeRegisterRow,
  StageWeightRow,
  StatusDailyRow,
  StockRow,
} from "./engine";

// ---------------------------------------------------------------------------
// Supabase adapter for the MRP engine's data-access interface. All reads are
// PAGED (PostgREST caps unordered selects at 1000 rows — mrp_demand_events is
// already past 2,600) with a stable order column so pages can't skip or
// duplicate rows. Service-role client only; the engine itself never sees
// Supabase.
// ---------------------------------------------------------------------------

const PAGE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function pageAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`mrp engine read failed (${label}): ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

// Without generated DB types supabase-js can't know a to-one embed from a
// to-many, so it infers arrays; at runtime PostgREST returns an OBJECT for the
// many-to-one FK joins here. Type both shapes and normalize.
interface ReceiptJoinRow {
  qty_received: number;
  po: { from_entity: string } | { from_entity: string }[] | null;
  line: { sku: string } | { sku: string }[] | null;
}

function one<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

export function createSupabaseEngineData(admin: SupabaseClient): EngineData {
  return {
    profiles: () =>
      pageAll<ProfileRow>("profiles", (from, to) =>
        admin.from("mrp_buffer_profile").select("*").order("sku").range(from, to)
      ),

    demandEvents: (since) =>
      pageAll<DemandEventRow>("demand_events", (from, to) =>
        admin
          .from("mrp_demand_events")
          .select("event_date, sku, qty, source")
          .in("region", ["US", "CA"])
          .gt("event_date", since)
          .order("id")
          .range(from, to)
      ),

    stockLevels: () =>
      pageAll<StockRow>("stock_levels", (from, to) =>
        admin
          .from("warehouse_stock_levels")
          .select("warehouse_code, sku, quantity_on_hand, last_counted_at")
          .order("id")
          .range(from, to)
      ),

    shipments: () =>
      pageAll<ShipmentRow>("shipments", (from, to) =>
        admin.from("shipment_contents").select("sku, qty, status, po_id").order("id").range(from, to)
      ),

    // Open Hub depot-leg POs → their lines. Two steps (the id set is tiny) so
    // the line query stays a plain paged select.
    openPoLines: async () => {
      const pos = await pageAll<{ id: string }>("open_pos", (from, to) =>
        admin
          .from("purchase_orders")
          .select("id")
          .eq("source", "hub")
          .eq("leg", "DEPOT_TO_EB_GROUP")
          .in("status", ["requested", "approved", "shipped"])
          .order("id")
          .range(from, to)
      );
      if (pos.length === 0) return [];
      return pageAll<OpenPoLineRow>("open_po_lines", (from, to) =>
        admin
          .from("purchase_order_lines")
          .select("po_id, sku, quantity")
          .in(
            "po_id",
            pos.map((p) => p.id)
          )
          .order("id")
          .range(from, to)
      );
    },

    stageWeights: () =>
      pageAll<StageWeightRow>("stage_weights", (from, to) =>
        admin
          .from("mrp_stage_weights")
          .select("stage_id, win_weight, is_late_stage")
          .order("stage_id")
          .range(from, to)
      ),

    openDeals: () =>
      pageAll<DealRow>("open_deals", (from, to) =>
        admin
          .from("deals_registry")
          .select("hubspot_deal_id, deal_status, line_items_raw")
          .neq("deal_status", "closedwon")
          .neq("deal_status", "closedlost")
          .not("line_items_raw", "is", null)
          .order("id")
          .range(from, to)
      ),

    closedWonDeals: () =>
      pageAll<DealRow>("closedwon_deals", (from, to) =>
        admin
          .from("deals_registry")
          .select("hubspot_deal_id, deal_status, line_items_raw")
          .eq("deal_status", "closedwon")
          .not("line_items_raw", "is", null)
          .order("id")
          .range(from, to)
      ),

    hubspotDemandDealIds: async () => {
      const rows = await pageAll<{ source_ref: string }>("hubspot_demand_refs", (from, to) =>
        admin
          .from("mrp_demand_events")
          .select("source_ref")
          .eq("source", "hubspot_deal")
          .order("id")
          .range(from, to)
      );
      return new Set(rows.map((r) => r.source_ref));
    },

    bomProducts: () =>
      pageAll<BomProductRow>("bom_products", (from, to) =>
        admin.from("mrp_bom_product").select("fg_code, pallet_size").order("fg_code").range(from, to)
      ),

    bomComponents: () =>
      pageAll<BomComponentRow>("bom_components", (from, to) =>
        admin
          .from("mrp_bom_component")
          .select("fg_code, component_code, component_desc, qty, basis, line_type, is_gating")
          .order("fg_code")
          .order("component_code")
          .range(from, to)
      ),

    bomSkuMap: () =>
      pageAll<BomSkuMapRow>("bom_sku_map", (from, to) =>
        admin.from("mrp_bom_sku_map").select("hub_sku, fg_code, confirmed").order("hub_sku").range(from, to)
      ),

    materialStock: () =>
      pageAll<MaterialStockRow>("material_stock", (from, to) =>
        // PHYSICAL quantity, never available_quantity — the latter is net of
        // reservations Bamida never drains and runs deeply negative.
        admin
          .from("bamida_material_stock")
          .select("ns_number, quantity")
          .eq("is_active", true)
          .order("id")
          .range(from, to)
      ),

    doorLeadTimeDays: async () => {
      const rows = await pageAll<{ days: number }>("door_lead_times", (from, to) =>
        admin.from("mrp_lead_time_actuals").select("days").eq("leg", "door").order("id").range(from, to)
      );
      return rows.map((r) => r.days);
    },

    receiptRows: async () => {
      const rows = (await pageAll<unknown>("receipts", (from, to) =>
        admin
          .from("po_line_receipts")
          .select(
            "qty_received, po:purchase_orders!inner(from_entity, status, source), line:purchase_order_lines!inner(sku)"
          )
          .eq("po.source", "hub")
          .in("po.status", ["approved", "delivered"])
          .order("id")
          .range(from, to)
      )) as ReceiptJoinRow[];
      const out: ReceiptRow[] = [];
      for (const r of rows) {
        const po = one(r.po);
        const line = one(r.line);
        if (po && line) out.push({ depot: po.from_entity, sku: line.sku, qty: r.qty_received });
      }
      return out;
    },

    persistStatus: async (rows: StatusDailyRow[]) => {
      if (rows.length === 0) return;
      const { error } = await admin
        .from("mrp_buffer_status_daily")
        .upsert(rows, { onConflict: "run_date,sku" });
      if (error) throw new Error(`mrp engine persist failed (status_daily): ${error.message}`);
    },

    persistSpikes: async (rows: SpikeRegisterRow[]) => {
      if (rows.length === 0) return;
      const { error } = await admin
        .from("mrp_spike_register")
        .upsert(rows, { onConflict: "run_date,deal_id,sku" });
      if (error) throw new Error(`mrp engine persist failed (spike_register): ${error.message}`);
    },

    writeBackProfiles: async (updates: ProfileWriteBack[]) => {
      for (const u of updates) {
        const { sku, ...fields } = u;
        const { error } = await admin.from("mrp_buffer_profile").update(fields).eq("sku", sku);
        if (error) throw new Error(`mrp engine profile write-back failed (${sku}): ${error.message}`);
      }
    },
  };
}
