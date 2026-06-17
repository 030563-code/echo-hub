export interface PurchaseOrder {
  id: string;
  po_number: string;
  parent_po_id: string | null;
  master_ref: string | null;
  leg: "DEPOT_TO_EB_GROUP" | "EB_GROUP_TO_SRO" | "SRO_TO_SUPPLIER";
  from_entity: string;
  to_entity: string;
  /** Cross-reference to the parent leg's PO# (group → master depot#, sro → EBG#). */
  reference_po_number: string | null;
  status:
    | "requested"
    | "approved"
    | "rejected"
    | "sro_evaluating"
    | "fulfilling_from_stock"
    | "in_manufacturing"
    | "shipped"
    | "delivered"
    | "cancelled";
  fulfilment_type: "stock" | "manufacture" | null;
  notes: string | null;
  /** Origin marker. 'hub' = raised/approved in the Hub; 'n8n' = the legacy Xero-poll flow. */
  source: "hub" | "n8n";
  delivery_address: string | null;
  requested_by: string | null;
  approved_by: string | null;
  decided_by: string | null;
  /** auth.users id of the raiser/approver (the real Hub identity trail). */
  requested_by_uid: string | null;
  approved_by_uid: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  decided_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  lines?: PurchaseOrderLine[];
}

export interface PurchaseOrderLine {
  id: string;
  po_id: string;
  sku: string;
  product_name: string | null;
  product_family: string | null;
  quantity: number;
  sku_suffix: "S" | "M" | null;
  stock_available: number | null;
  hs_code: string | null;
  unit_price: number | null;
  created_at: string;
  updated_at: string;
}

// Hub-owned PO picklists (seeded in 20260615000000_hub_po_write_flow.sql).
export interface PoProductCatalogItem {
  sku: string;
  product_name: string | null;
  product_family: string | null;
  region: string;
  active: boolean;
  /** product_code_master key → resolves the per-entity Xero product code. */
  internal_sku: string | null;
}

/** Per-entity Xero product codes for one product (from product_code_master). */
export interface ProductEntityCodes {
  internal_sku: string;
  code_usa_balt: string | null;
  code_usa_sb: string | null;
  code_canada: string | null;
  code_grp: string | null;
  code_sro: string | null;
}

export interface PoDeliveryAddress {
  id: string;
  entity: string;
  label: string;
  address: string | null;
  active: boolean;
}

export interface PoHsCode {
  code: string;
  description: string | null;
  active: boolean;
}

// --- BOM explosion (live read of mfg bom_weekly_snapshot.component_detail) -----

/** One component_detail entry from the mfg snapshot. */
export interface BomComponent {
  code: string;
  desc: string | null;
  qty: number;
  currency: string | null;
  dutiable: boolean;
  unit_cost_eur: number;
  extended_eur: number;
}

/** An editable master BOM row (mfg.bom_weekly_snapshot, latest week). */
export interface BomMasterRow {
  model_code: string;
  product_line: string | null;
  week_start_date: string;
  bamida_man_eur: number | null;
  bamida_print_eur: number | null;
  bamida_total_eur: number | null;
  sro_components_eur: number | null;
  sro_duty_8pct_eur: number | null;
  sro_admin_eur: number | null;
  sro_total_eur: number | null;
  bom_total_eur: number | null;
  fx_gbp_eur: number | null;
  bom_change_pct: number | null;
  component_detail: BomComponent[];
}

/** One SRO-PO line, exploded into its BOM (component qty/cost × the line qty). */
export interface SroPoBomLine {
  sku: string;
  product_name: string | null;
  quantity: number;
  model_code: string | null;
  has_bom: boolean;
  components: (BomComponent & { line_qty: number; line_extended_eur: number })[];
  bamida_man_eur: number;
  bamida_print_eur: number;
  components_eur_unit: number;
  /** Bamida draft-PO total for the line = (components + man + print) × qty. */
  bamida_total_line: number;
  /** SRO costs for the line (recorded, NOT in the Bamida PO) = (components+duty+admin) × qty. */
  sro_total_line: number;
}

/** An approved EB_GROUP_TO_SRO PO with its exploded BOM. */
export interface SroPoBom {
  id: string;
  po_number: string;
  master_ref: string | null;
  from_entity: string;
  to_entity: string;
  approved_at: string | null;
  created_at: string;
  lines: SroPoBomLine[];
  bamida_total: number;
  sro_total: number;
}

export interface Deal {
  id: number;
  hubspot_deal_id: string;
  hubspot_company_id: string | null;
  deal_name: string | null;
  deal_status: string | null;
  amount: number | null;
  currency: string;
  quote_reference: string | null;
  depot_code: string | null;
  line_items_raw: LineItem[];
  deal_probability: number | null;
  created_at: string;
  updated_at: string;
  invoice?: InvoiceRecord | null;
}

export interface LineItem {
  sku?: string;
  quantity?: number;
  name?: string;
  price?: number;
  [key: string]: unknown;
}

export interface InvoiceRecord {
  hubspot_deal_id: string;
  invoice_number: string | null;
  company_name: string | null;
  currency_code: string | null;
  total_amount: number | null;
  due_date: string | null;
  xero_invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseStock {
  id: string;
  warehouse_code: string;
  sku: string;
  product_name: string | null;
  quantity_on_hand: number;
  last_counted_at: string | null;
  updated_at: string | null;
}

export interface ShipmentContent {
  id: string;
  spot_id: string;
  container_ref: string | null;
  sku: string;
  product_name: string | null;
  qty: number;
  depot_destination: "US-BAL" | "US-SBD" | "CA-HAM" | null;
  status: "on_water" | "at_port" | "customs" | "delivered";
  shipped_at: string | null;
  eta: string | null;
  delivered_at: string | null;
  po_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface MRPRow {
  sku: string;
  product_name: string | null;
  in_stock: number;
  in_transit: number;
  on_order: number;
  cip: number;
  pipeline_demand: number;
  daily_run_rate: number;
  lead_time_days: number;
  lead_time_demand: number;
  safety_stock: number;
  trigger_threshold: number;
  status: "green" | "yellow" | "red";
}
