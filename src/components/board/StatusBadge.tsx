import { cn } from "@/lib/utils";

/**
 * One label and one hue per status; LIGHT turns it into classes.
 *
 * The badges were originally written for the dark boards, where a
 * 40%-opacity 900 fill under 300 text read cleanly. Every module is white
 * now, so each status carries a hue mapped straight to its white-surface
 * classes.
 */
type Hue =
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "teal"
  | "purple"
  | "indigo"
  | "emerald"
  | "orange"
  | "zinc";

const STATUS_CONFIG: Record<string, { label: string; hue: Hue }> = {
  // PO statuses
  requested:             { label: "Requested",      hue: "blue" },
  approved:              { label: "Approved",       hue: "green" },
  rejected:              { label: "Rejected",       hue: "red" },
  sro_evaluating:        { label: "SRO Evaluating", hue: "yellow" },
  fulfilling_from_stock: { label: "From Stock",     hue: "teal" },
  in_manufacturing:      { label: "Manufacturing",  hue: "purple" },
  ready_for_shipment:    { label: "Ready for shipment", hue: "orange" },
  shipped:               { label: "Shipped",        hue: "indigo" },
  delivered:             { label: "Delivered",      hue: "emerald" },
  cancelled:             { label: "Cancelled",      hue: "zinc" },
  // Shipment statuses
  on_water:              { label: "On Water",       hue: "blue" },
  at_port:               { label: "At Port",        hue: "yellow" },
  customs:               { label: "Customs",        hue: "orange" },
  // Deal statuses
  open:                  { label: "Open",           hue: "blue" },
  closedwon:             { label: "Closed Won",     hue: "emerald" },
  closedlost:            { label: "Closed Lost",    hue: "red" },
  // SKU suffix
  S:                     { label: "Stock",          hue: "teal" },
  M:                     { label: "Manufacture",    hue: "purple" },
  // Fulfilment type
  stock:                 { label: "Stock",          hue: "teal" },
  manufacture:           { label: "Manufacture",    hue: "purple" },
  // Stock board: how fresh the last physical count is
  never_counted:         { label: "Never counted",  hue: "red" },
  count_stale:           { label: "Stale count",    hue: "yellow" },
  counted:               { label: "Counted",        hue: "emerald" },
  // Stock ledger movement kinds
  receipt:               { label: "Receipt",        hue: "green" },
  count:                 { label: "Count",          hue: "blue" },
  manufactured:          { label: "Manufactured",   hue: "purple" },
  shipped_out:           { label: "Shipped out",    hue: "indigo" },
  customer_dispatch:     { label: "Dispatched",     hue: "teal" },
  material_consumed:     { label: "Consumed",       hue: "orange" },
  adjustment:            { label: "Adjustment",     hue: "zinc" },
};

const LIGHT: Record<Hue, string> = {
  blue: "bg-blue-50 text-blue-800 border-blue-200",
  green: "bg-green-50 text-green-800 border-green-200",
  red: "bg-red-50 text-red-800 border-red-200",
  yellow: "bg-yellow-50 text-yellow-800 border-yellow-200",
  teal: "bg-teal-50 text-teal-800 border-teal-200",
  purple: "bg-purple-50 text-purple-800 border-purple-200",
  indigo: "bg-indigo-50 text-indigo-800 border-indigo-200",
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
  orange: "bg-orange-50 text-orange-800 border-orange-200",
  zinc: "bg-gray-100 text-gray-600 border-gray-300",
};

interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  if (!status) return <span className="text-gray-400">{"—"}</span>;
  const key = status.toLowerCase().replace(/\s+/g, "");
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG[key] ?? { label: status, hue: "zinc" as const };
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap",
        LIGHT[config.hue],
        className
      )}
    >
      {config.label}
    </span>
  );
}
