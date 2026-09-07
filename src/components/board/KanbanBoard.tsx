"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Package, Clock, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import StatusBadge from "./StatusBadge";
import { displayPoNumber, legLabel } from "@/lib/po-number";
import { LIFECYCLE_STAGES, effectiveStage, stageLabel, type LifecycleStage } from "@/lib/po-lifecycle";
import type { PurchaseOrder } from "@/lib/erp-types";
import { formatRelative } from "@/lib/utils";

interface KanbanBoardProps {
  orders: PurchaseOrder[];
  onCardClick?: (order: PurchaseOrder) => void;
  /** When true, cards can be dragged between columns (needs po.approve / po.receive). */
  canMove?: boolean;
  /** Persist a move — called with the PO id + the column it was dropped on. */
  onMove?: (poId: string, stage: LifecycleStage) => void;
}

export default function KanbanBoard({ orders, onCardClick, canMove = false, onMove }: KanbanBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<LifecycleStage | null>(null);

  function handleDrop(stage: LifecycleStage) {
    const id = draggingId;
    setDraggingId(null);
    setOverStage(null);
    if (!id || !onMove) return;
    const dragged = orders.find((o) => o.id === id);
    if (!dragged || effectiveStage(dragged) === stage) return; // no-op
    onMove(id, stage);
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {LIFECYCLE_STAGES.map((col) => {
        const colOrders = orders.filter((o) => effectiveStage(o) === col.key);
        const isOver = overStage === col.key;
        return (
          <div
            key={col.key}
            className="flex-shrink-0 w-64"
            onDragOver={
              canMove
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overStage !== col.key) setOverStage(col.key);
                  }
                : undefined
            }
            onDragLeave={
              canMove
                ? (e) => {
                    // Only clear if we actually left the column (not entered a child).
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((s) => (s === col.key ? null : s));
                  }
                : undefined
            }
            onDrop={canMove ? () => handleDrop(col.key) : undefined}
          >
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2 mb-2">
              <span className="text-xs font-medium text-[#9ca3af] uppercase tracking-wider">{col.label}</span>
              <span className="text-xs text-[#4b5563] bg-[#1e1e1e] px-1.5 py-0.5 rounded-full">{colOrders.length}</span>
            </div>

            {/* Cards / drop zone */}
            <div
              className={cn(
                "space-y-2 rounded-lg min-h-[80px] transition-colors",
                isOver && "outline-2 outline-dashed outline-[#025945] bg-[#025945]/10 p-1"
              )}
            >
              {colOrders.map((order) => (
                <POCard
                  key={order.id}
                  order={order}
                  draggable={canMove}
                  isDragging={draggingId === order.id}
                  onDragStart={(e) => {
                    setDraggingId(order.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", order.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setOverStage(null);
                  }}
                  onClick={() => onCardClick?.(order)}
                />
              ))}
              {colOrders.length === 0 && (
                <div className="border border-dashed border-[#2a2a2a] rounded-lg px-3 py-6 text-center text-[#4b5563] text-xs">
                  {isOver ? "Drop here" : "No orders"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function POCard({
  order,
  onClick,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}: {
  order: PurchaseOrder;
  onClick: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = order.lines ?? [];

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-3 hover:border-[#3a3a3a] transition-colors",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        isDragging && "opacity-40"
      )}
      onClick={onClick}
    >
      {/* PO number + leg badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-start gap-1.5 min-w-0">
          {draggable && (
            <GripVertical className="w-3.5 h-3.5 text-[#3a3a3a] group-hover:text-[#6b7280] flex-shrink-0 mt-0.5 transition-colors" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-mono text-[#FF7026] font-medium truncate">{displayPoNumber(order.po_number)}</p>
            {order.reference_po_number && (
              <p className="text-[10px] text-[#4b5563] font-mono truncate">Ref: {displayPoNumber(order.reference_po_number)}</p>
            )}
          </div>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#6b7280] whitespace-nowrap flex-shrink-0">
          {legLabel(order.leg)}
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
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
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
                    {line.sku}
                    {line.sku_suffix ? `-${line.sku_suffix}` : ""}
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

// Re-exported for callers that want the human label of a dropped column.
export { stageLabel };
