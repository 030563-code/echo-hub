export interface PurchaseOrder {
  id: string;
  po_number: string;
  parent_po_id: string | null;
  master_ref: string | null;
  leg: "DEPOT_TO_EB_GROUP" | "EB_GROUP_TO_SRO";
  from_entity: string;
  to_entity: string;
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
