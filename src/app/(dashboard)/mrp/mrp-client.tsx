"use client";

import BoardTable from "@/components/board/BoardTable";
import TrafficLight from "@/components/board/TrafficLight";
import type { MRPRow } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";

function NumCell({ value, highlight }: { value: number; highlight?: "red" | "orange" }) {
  const color = highlight === "red" ? "text-red-300" : highlight === "orange" ? "text-[#FF7026]" : "text-[#e5e5e5]";
  return <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>;
}

const COLUMNS: ColumnDef<MRPRow, unknown>[] = [
  {
    id: "status_light",
    header: "Status",
    accessorKey: "status",
    cell: ({ getValue }) => <TrafficLight status={getValue() as "green" | "yellow" | "red"} size="md" />,
  },
  {
    accessorKey: "sku",
    header: "SKU",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-[#FF7026] font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "product_name",
    header: "Product",
    cell: ({ getValue }) => (
      <span className="text-sm text-[#9ca3af] max-w-[200px] truncate block">{(getValue() as string | null) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "in_stock",
    header: "In Stock",
    cell: ({ row }) => <NumCell value={row.original.in_stock} highlight={row.original.in_stock === 0 ? "red" : undefined} />,
  },
  {
    accessorKey: "in_transit",
    header: "In Transit",
    cell: ({ getValue }) => <NumCell value={getValue() as number} />,
  },
  {
    accessorKey: "on_order",
    header: "On Order",
    cell: ({ getValue }) => <NumCell value={getValue() as number} />,
  },
  {
    accessorKey: "cip",
    header: "CIP",
    cell: ({ row }) => (
      <NumCell
        value={row.original.cip}
        highlight={row.original.cip <= row.original.trigger_threshold ? "red" : "orange"}
      />
    ),
  },
  {
    accessorKey: "pipeline_demand",
    header: "Pipeline Demand",
    cell: ({ getValue }) => <NumCell value={getValue() as number} />,
  },
  {
    accessorKey: "lead_time_demand",
    header: "LT Demand",
    cell: ({ getValue }) => <NumCell value={getValue() as number} />,
  },
  {
    accessorKey: "safety_stock",
    header: "Safety Stock",
    cell: ({ getValue }) => <span className="text-xs text-[#6b7280] tabular-nums">{getValue() as number}</span>,
  },
  {
    accessorKey: "trigger_threshold",
    header: "Trigger",
    cell: ({ getValue }) => (
      <span className="text-sm font-bold text-[#FF7026] tabular-nums">{getValue() as number}</span>
    ),
  },
  {
    accessorKey: "daily_run_rate",
    header: "Run Rate/day",
    cell: ({ getValue }) => (
      <span className="text-xs text-[#4b5563] tabular-nums">{(getValue() as number).toFixed(2)}</span>
    ),
  },
];

export default function MRPClient({ rows }: { rows: MRPRow[] }) {
  return (
    <BoardTable
      data={rows}
      columns={COLUMNS}
      pageSize={20}
      searchPlaceholder="Search SKU or product..."
      emptyMessage="No SKUs found in warehouse_stock_levels"
    />
  );
}
