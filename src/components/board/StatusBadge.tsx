import { cn } from "@/lib/utils";

/**
 * One label and one hue per status; the surface decides the shade.
 *
 * The badges were written for the dark boards, where a 40%-opacity 900 fill
 * under 300 text reads cleanly. On white the same pair goes muddy, so each
 * status now carries a hue and the two skins below turn it into classes. Same
 * `dark` convention as BoardTable, search-box and empty-state: dark by default,
 * because Purchase Orders and MRP are still dark and are not changing here.
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
};

const DARK: Record<Hue, string> = {
  blue: "bg-blue-900/40 text-blue-300 border-blue-800/50",
  green: "bg-green-900/40 text-green-300 border-green-800/50",
  red: "bg-red-900/40 text-red-300 border-red-800/50",
  yellow: "bg-yellow-900/40 text-yellow-300 border-yellow-800/50",
  teal: "bg-teal-900/40 text-teal-300 border-teal-800/50",
  purple: "bg-purple-900/40 text-purple-300 border-purple-800/50",
  indigo: "bg-indigo-900/40 text-indigo-300 border-indigo-800/50",
  emerald: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50",
  orange: "bg-orange-900/40 text-orange-300 border-orange-800/50",
  zinc: "bg-zinc-800/60 text-zinc-400 border-zinc-700/50",
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
  /** False on a light surface. Defaults to the dark boards this was built for. */
  dark?: boolean;
}

export default function StatusBadge({ status, className, dark = true }: StatusBadgeProps) {
  if (!status) return <span className={dark ? "text-[#4b5563]" : "text-gray-400"}>{"—"}</span>;
  const key = status.toLowerCase().replace(/\s+/g, "");
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG[key] ?? { label: status, hue: "zinc" as const };
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap",
        (dark ? DARK : LIGHT)[config.hue],
        className
      )}
    >
      {config.label}
    </span>
  );
}
