"use client";

import BoardTable from "@/components/board/BoardTable";
import type { ColumnDef } from "@tanstack/react-table";

export interface BomRow {
  model_code: string;
  product_line: string | null;
  bamida_total_eur: number | null;
  sro_total_eur: number | null;
  bom_total_eur: number | null;
  bom_change_eur: number | null;
  bom_change_pct: number | null;
  fx_gbp_eur: number | null;
}

const eur = (v: number | null) =>
  v == null ? "—" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ChangeCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-[#4b5563]">—</span>;
  const up = pct > 0;
  const flat = pct === 0;
  const color = flat ? "text-[#6b7280]" : up ? "text-red-300" : "text-emerald-300";
  const arrow = flat ? "" : up ? "▲" : "▼";
  return (
    <span className={`text-sm font-bold tabular-nums ${color}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

const COLUMNS: ColumnDef<BomRow, unknown>[] = [
  {
    accessorKey: "model_code",
    header: "Model",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-[#FF7026] font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "product_line",
    header: "Product Line",
    cell: ({ getValue }) => (
      <span className="text-sm text-[#9ca3af]">{(getValue() as string | null) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "bamida_total_eur",
    header: "Bamida (mfg)",
    cell: ({ getValue }) => <span className="text-sm tabular-nums text-[#e5e5e5]">{eur(getValue() as number | null)}</span>,
  },
  {
    accessorKey: "sro_total_eur",
    header: "SRO Components",
    cell: ({ getValue }) => <span className="text-sm tabular-nums text-[#e5e5e5]">{eur(getValue() as number | null)}</span>,
  },
  {
    accessorKey: "bom_total_eur",
    header: "BOM Total",
    cell: ({ getValue }) => (
      <span className="text-sm font-bold tabular-nums text-[#FF7026]">{eur(getValue() as number | null)}</span>
    ),
  },
  {
    accessorKey: "bom_change_pct",
    header: "WoW Change",
    cell: ({ getValue }) => <ChangeCell pct={getValue() as number | null} />,
  },
];

export default function BomClient({ rows }: { rows: BomRow[] }) {
  return (
    <BoardTable
      data={rows}
      columns={COLUMNS}
      pageSize={25}
      searchPlaceholder="Search model or product line..."
      emptyMessage="No BOM snapshot rows for the latest week"
    />
  );
}
