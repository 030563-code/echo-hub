"use client";

import { PackageSearch } from "lucide-react";
import BoardTable from "@/components/board/BoardTable";
import TrafficLight from "@/components/board/TrafficLight";
import { EmptyState } from "@/components/ui/empty-state";
import type { MRPRow } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";

function NumCell({ value, highlight }: { value: number; highlight?: "red" | "orange" }) {
  const color = highlight === "red" ? "text-red-700" : highlight === "orange" ? "text-echo-orange" : "text-gray-900";
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
      <span className="font-mono text-xs text-echo-orange font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "product_name",
    header: "Product",
    cell: ({ getValue }) => (
      <span className="text-sm text-gray-600 max-w-[200px] truncate block">{(getValue() as string | null) ?? "—"}</span>
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
    cell: ({ getValue }) => <span className="text-xs text-gray-500 tabular-nums">{getValue() as number}</span>,
  },
  {
    accessorKey: "trigger_threshold",
    header: "Trigger",
    cell: ({ getValue }) => (
      <span className="text-sm font-bold text-echo-orange tabular-nums">{getValue() as number}</span>
    ),
  },
  {
    accessorKey: "daily_run_rate",
    header: "Run Rate/day",
    cell: ({ getValue }) => (
      <span className="text-xs text-gray-400 tabular-nums">{(getValue() as number).toFixed(2)}</span>
    ),
  },
];

export default function MRPClient({ rows }: { rows: MRPRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<PackageSearch className="w-7 h-7" />}
        title="No SKUs to reorder"
        description="No SKUs found in warehouse_stock_levels."
      />
    );
  }
  return (
    <BoardTable
      stateKey="mrp-board"
      data={rows}
      columns={COLUMNS}
      pageSize={20}
      searchPlaceholder="Search SKU or product..."
      emptyMessage="No SKUs found in warehouse_stock_levels"
    />
  );
}
