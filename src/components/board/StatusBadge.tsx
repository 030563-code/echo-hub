import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  // PO statuses
  requested:            { label: "Requested",       className: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  approved:             { label: "Approved",         className: "bg-green-900/40 text-green-300 border-green-800/50" },
  rejected:             { label: "Rejected",         className: "bg-red-900/40 text-red-300 border-red-800/50" },
  sro_evaluating:       { label: "SRO Evaluating",   className: "bg-yellow-900/40 text-yellow-300 border-yellow-800/50" },
  fulfilling_from_stock:{ label: "From Stock",       className: "bg-teal-900/40 text-teal-300 border-teal-800/50" },
  in_manufacturing:     { label: "Manufacturing",    className: "bg-purple-900/40 text-purple-300 border-purple-800/50" },
  shipped:              { label: "Shipped",          className: "bg-indigo-900/40 text-indigo-300 border-indigo-800/50" },
  delivered:            { label: "Delivered",        className: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50" },
  cancelled:            { label: "Cancelled",        className: "bg-zinc-800/60 text-zinc-400 border-zinc-700/50" },
  // Shipment statuses
  on_water:             { label: "On Water",         className: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  at_port:              { label: "At Port",          className: "bg-yellow-900/40 text-yellow-300 border-yellow-800/50" },
  customs:              { label: "Customs",          className: "bg-orange-900/40 text-orange-300 border-orange-800/50" },
  // Deal statuses
  open:                 { label: "Open",             className: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  closedwon:            { label: "Closed Won",       className: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50" },
  closedlost:           { label: "Closed Lost",      className: "bg-red-900/40 text-red-300 border-red-800/50" },
  // SKU suffix
  S:                    { label: "Stock",            className: "bg-teal-900/40 text-teal-300 border-teal-800/50" },
  M:                    { label: "Manufacture",      className: "bg-purple-900/40 text-purple-300 border-purple-800/50" },
  // Fulfilment type
  stock:                { label: "Stock",            className: "bg-teal-900/40 text-teal-300 border-teal-800/50" },
  manufacture:          { label: "Manufacture",      className: "bg-purple-900/40 text-purple-300 border-purple-800/50" },
};

interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  if (!status) return <span className="text-[#4b5563]">—</span>;
  const key = status.toLowerCase().replace(/\s+/g, "");
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG[key] ?? {
    label: status,
    className: "bg-zinc-800/60 text-zinc-400 border-zinc-700/50",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap",
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  );
}
