"use client";

import { useState } from "react";
import { LayoutGrid, List, X } from "lucide-react";
import KanbanBoard from "@/components/board/KanbanBoard";
import BoardTable from "@/components/board/BoardTable";
import StatusBadge from "@/components/board/StatusBadge";
import { cn, formatRelative } from "@/lib/utils";
import type { PurchaseOrder } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";

function legLabel(leg: string): string {
  if (leg === "DEPOT_TO_EB_GROUP") return "Depot → Group";
  if (leg === "EB_GROUP_TO_SRO") return "Group → SRO";
  if (leg === "SRO_TO_SUPPLIER") return "SRO → Supplier";
  return leg;
}

const TABLE_COLUMNS: ColumnDef<PurchaseOrder, unknown>[] = [
  {
    accessorKey: "po_number",
    header: "PO Number",
    cell: ({ getValue }) => (
      <span className="font-mono text-[#FF7026] text-xs font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "from_entity",
    header: "From",
    cell: ({ getValue }) => <span className="text-[#9ca3af] text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "to_entity",
    header: "To",
    cell: ({ getValue }) => <span className="text-[#9ca3af] text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "leg",
    header: "Leg",
    cell: ({ getValue }) => (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#6b7280]">
        {legLabel(getValue() as string)}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
  },
  {
    accessorKey: "fulfilment_type",
    header: "Fulfilment",
    cell: ({ getValue }) => <StatusBadge status={getValue() as string | null} />,
  },
  {
    id: "skus",
    header: "SKUs",
    accessorFn: (row) => row.lines?.map((l) => l.sku).join(", ") ?? "",
    cell: ({ getValue }) => (
      <span className="text-xs text-[#6b7280] font-mono max-w-[200px] truncate block">
        {(getValue() as string) || "—"}
      </span>
    ),
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ getValue }) => (
      <span className="text-xs text-[#6b7280]">{formatRelative(getValue() as string)}</span>
    ),
  },
];

interface Props {
  orders: PurchaseOrder[];
}

export default function PurchasingClient({ orders }: Props) {
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);

  return (
    <div className="relative">
      {/* View toggle */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-0.5">
          {(["kanban", "table"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                view === v ? "bg-[#2a2a2a] text-[#e5e5e5]" : "text-[#6b7280] hover:text-[#9ca3af]"
              )}
            >
              {v === "kanban" ? <LayoutGrid className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
              {v === "kanban" ? "Kanban" : "Table"}
            </button>
          ))}
        </div>
        <span className="text-xs text-[#4b5563]">{orders.length} orders</span>
      </div>

      {/* Board */}
      {view === "kanban" ? (
        <KanbanBoard orders={orders} onCardClick={setSelected} />
      ) : (
        <BoardTable
          data={orders}
          columns={TABLE_COLUMNS}
          searchPlaceholder="Search PO number, entity, SKU..."
          onRowClick={setSelected}
          emptyMessage="No purchase orders found"
        />
      )}

      {/* Side panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 w-96 bg-[#161616] border-l border-[#2a2a2a] z-50 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a2a]">
            <div>
              <p className="font-mono text-[#FF7026] font-medium">{selected.po_number}</p>
              <p className="text-xs text-[#4b5563]">{selected.master_ref && `ref: ${selected.master_ref}`}</p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="p-1.5 hover:bg-[#2a2a2a] rounded-lg transition-colors text-[#6b7280] hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <DetailSection label="Status">
              <StatusBadge status={selected.status} />
            </DetailSection>

            <DetailSection label="Route">
              <p className="text-sm text-[#e5e5e5]">{selected.from_entity}</p>
              <p className="text-xs text-[#4b5563]">↓ {legLabel(selected.leg)}</p>
              <p className="text-sm text-[#e5e5e5]">{selected.to_entity}</p>
            </DetailSection>

            {selected.reference_po_number && (
              <DetailSection label="Reference PO">
                <p className="text-sm font-mono text-[#9ca3af]">{selected.reference_po_number}</p>
              </DetailSection>
            )}

            {selected.fulfilment_type && (
              <DetailSection label="Fulfilment Type">
                <StatusBadge status={selected.fulfilment_type} />
              </DetailSection>
            )}

            {(selected.lines ?? []).length > 0 && (
              <DetailSection label="Line Items">
                <div className="space-y-2">
                  {(selected.lines ?? []).map((line) => (
                    <div key={line.id} className="flex items-center justify-between bg-[#1e1e1e] rounded-lg px-3 py-2">
                      <div>
                        <p className="text-xs font-mono text-[#e5e5e5]">
                          {line.sku}{line.sku_suffix ? `-${line.sku_suffix}` : ""}
                        </p>
                        {line.product_name && (
                          <p className="text-[10px] text-[#4b5563]">{line.product_name}</p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-[#e5e5e5] font-medium">×{line.quantity}</p>
                        {line.stock_available != null && (
                          <p className="text-[10px] text-[#4b5563]">{line.stock_available} in stock</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}

            <DetailSection label="Timeline">
              <TimelineItem label="Created" date={selected.created_at} />
              {selected.approved_at && <TimelineItem label="Approved" date={selected.approved_at} by={selected.approved_by} />}
              {selected.decided_at && <TimelineItem label="SRO Decision" date={selected.decided_at} by={selected.decided_by} />}
              {selected.shipped_at && <TimelineItem label="Shipped" date={selected.shipped_at} />}
              {selected.delivered_at && <TimelineItem label="Delivered" date={selected.delivered_at} />}
            </DetailSection>

            {selected.notes && (
              <DetailSection label="Notes">
                <p className="text-sm text-[#9ca3af]">{selected.notes}</p>
              </DetailSection>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-[#4b5563] font-medium mb-1.5">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function TimelineItem({ label, date, by }: { label: string; date: string; by?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="w-1.5 h-1.5 rounded-full bg-[#FF7026] mt-1 flex-shrink-0" />
      <div>
        <span className="text-[#9ca3af]">{label}</span>
        <span className="text-[#4b5563] ml-1">{formatRelative(date)}</span>
        {by && <span className="text-[#4b5563] ml-1">by {by}</span>}
      </div>
    </div>
  );
}
