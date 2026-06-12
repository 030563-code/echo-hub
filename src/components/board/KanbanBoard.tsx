"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Package, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import StatusBadge from "./StatusBadge";
import type { PurchaseOrder } from "@/lib/erp-types";
import { formatRelative } from "@/lib/utils";

const KANBAN_COLUMNS: { status: PurchaseOrder["status"]; label: string }[] = [
  { status: "requested",             label: "Requested" },
  { status: "approved",              label: "Approved" },
  { status: "sro_evaluating",        label: "SRO Evaluating" },
  { status: "fulfilling_from_stock", label: "From Stock" },
  { status: "in_manufacturing",      label: "Manufacturing" },
  { status: "shipped",               label: "Shipped" },
  { status: "delivered",             label: "Delivered" },
];

interface KanbanBoardProps {
  orders: PurchaseOrder[];
  onCardClick?: (order: PurchaseOrder) => void;
}

export default function KanbanBoard({ orders, onCardClick }: KanbanBoardProps) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {KANBAN_COLUMNS.map((col) => {
        const colOrders = orders.filter((o) => o.status === col.status);
        return (
          <div key={col.status} className="flex-shrink-0 w-64">
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2 mb-2">
              <span className="text-xs font-medium text-[#9ca3af] uppercase tracking-wider">
                {col.label}
              </span>
              <span className="text-xs text-[#4b5563] bg-[#1e1e1e] px-1.5 py-0.5 rounded-full">
                {colOrders.length}
              </span>
            </div>

            {/* Cards */}
            <div className="space-y-2">
              {colOrders.map((order) => (
                <POCard key={order.id} order={order} onClick={() => onCardClick?.(order)} />
              ))}
              {colOrders.length === 0 && (
                <div className="border border-dashed border-[#2a2a2a] rounded-lg px-3 py-6 text-center text-[#4b5563] text-xs">
                  No orders
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function POCard({ order, onClick }: { order: PurchaseOrder; onClick: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const lines = order.lines ?? [];

  return (
    <div
      className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-3 hover:border-[#3a3a3a] transition-colors cursor-pointer"
      onClick={onClick}
    >
      {/* PO number + leg badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <p className="text-xs font-mono text-[#FF7026] font-medium">{order.po_number}</p>
          {order.master_ref && order.master_ref !== order.po_number && (
            <p className="text-[10px] text-[#4b5563] font-mono">ref: {order.master_ref}</p>
          )}
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#6b7280] whitespace-nowrap flex-shrink-0">
          {order.leg === "DEPOT_TO_EB_GROUP" ? "Depot → Group" : "Group → SRO"}
        </span>
      </div>

      {/* Route */}
      <p className="text-xs text-[#9ca3af] mb-2 truncate">
        {order.from_entity} → {order.to_entity}
      </p>

      {/* Fulfilment type */}
      {order.fulfilment_type && (
        <div className="mb-2">
          <StatusBadge status={order.fulfilment_type} />
        </div>
      )}

      {/* Line items summary */}
      {lines.length > 0 && (
        <div className="border-t border-[#2a2a2a] pt-2 mt-2">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="flex items-center gap-1 text-[10px] text-[#6b7280] hover:text-[#9ca3af] transition-colors"
          >
            <Package className="w-3 h-3" />
            {lines.length} SKU{lines.length > 1 ? "s" : ""}
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {expanded && (
            <div className="mt-1.5 space-y-1">
              {lines.map((line) => (
                <div key={line.id} className="flex items-center justify-between text-[10px]">
                  <span className="font-mono text-[#9ca3af]">
                    {line.sku}{line.sku_suffix ? `-${line.sku_suffix}` : ""}
                  </span>
                  <span className="text-[#6b7280]">×{line.quantity}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timestamp */}
      <div className="flex items-center gap-1 mt-2 text-[10px] text-[#4b5563]">
        <Clock className="w-3 h-3" />
        {formatRelative(order.created_at)}
      </div>
    </div>
  );
}
