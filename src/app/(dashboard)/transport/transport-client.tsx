"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Search, X, Loader2 } from "lucide-react";
import BoardTable from "@/components/board/BoardTable";
import StatusBadge from "@/components/board/StatusBadge";
import { formatDate } from "@/lib/utils";
import type { ShipmentContent } from "@/lib/erp-types";
import type { ColumnDef } from "@tanstack/react-table";
import {
  lookupCargoPartnerShipment,
  addShipment,
  type AddShipmentInput,
} from "./actions";

const KNOWN_SKUS = [
  // ── North America ──────────────────────────────────────────
  { code: "EBH9NA",     name: "Echo Barrier H9" },
  { code: "EBH9WNA",    name: "Echo Barrier H9W" },
  { code: "EBH9XNA",    name: "Echo Barrier H9X" },
  { code: "EBH9ERNA",   name: "Echo Barrier H9 Ex Rental" },
  { code: "EBH10NA",    name: "Echo Barrier H10" },
  { code: "EBH10HERCNA",name: "Echo Barrier H10 HERC" },
  { code: "EBH8NA",     name: "Echo Barrier H8" },
  { code: "V2NA",       name: "Echo Barrier V2" },
  { code: "CCSNA",      name: "Compact Cutting Station" },
  { code: "FSCNA",      name: "Full Size Cutting Station" },
  { code: "BUNNA",      name: "Bungies" },
  { code: "HKNA",       name: "Hooks" },
  { code: "EBVFKNA",    name: "Vertical Fitting Kits" },
  { code: "M1NA",       name: "M1 Mini Gen Set" },
  // ── SRO / Slovakia — Standard ─────────────────────────────
  { code: "EBH9SK",     name: "H9 (SRO)" },
  { code: "EBH10SK",    name: "H10 (SRO)" },
  { code: "EBH9WSK",    name: "H9W (SRO)" },
  { code: "EBH9X21SK",  name: "H9X 2.1W (SRO)" },
  { code: "EBH9X15SK",  name: "H9X 1.5W (SRO)" },
  // ── SRO — Triples ─────────────────────────────────────────
  { code: "EBH8SK",     name: "H8 Triple (SRO)" },
  { code: "EBHT35SK",   name: "HT3.5 Triple (SRO)" },
  // ── SRO — Customer Specific ───────────────────────────────
  { code: "EBH9JAPSK",  name: "H9 Japan (SRO)" },
  { code: "EBH10JAPSK", name: "H10 Japan (SRO)" },
  { code: "EBH10HBSK",  name: "H10 HERC Black (SRO)" },
  // ── SRO — Samples ─────────────────────────────────────────
  { code: "EBH9MINISK", name: "H9 Mini Sample (SRO)" },
  { code: "EBH8MINISK", name: "H8 Mini Sample (SRO)" },
  // ── SRO — Noise Defender ──────────────────────────────────
  { code: "HERASSK",    name: "Noise Defender HERAS" },
  { code: "NDS200SK",   name: "Noise Defender NDS200" },
  { code: "NDTSK",      name: "Noise Defender NDT" },
  // ── SRO — Cutting Stations & Equipment ────────────────────
  { code: "CSFSSR",     name: "Full Size Cutting Station (SRO)" },
  { code: "CSCSSR",     name: "Compact Cutting Station (SRO)" },
  { code: "CSPTSK",     name: "CS Plus Tunnel (SRO)" },
  { code: "CSPWSK",     name: "CS Plus W (SRO)" },
  { code: "V2SK",       name: "Echo Barrier V2 (SRO)" },
  { code: "M1SK",       name: "M1 Mini Gen Set (SRO)" },
  { code: "GENEXTSK",   name: "Generator Extension Cable (SRO)" },
];

const DEPOT_OPTIONS = ["US-BAL", "US-SBD", "CA-HAM"] as const;
const STATUS_OPTIONS = ["on_water", "at_port", "customs", "delivered"] as const;

const EMPTY_FORM: AddShipmentInput = {
  spot_id: "",
  container_ref: "",
  sku: "",
  qty: 1,
  depot_destination: "US-BAL",
  status: "on_water",
  shipped_at: "",
  eta: "",
  po_reference: "",
};

const COLUMNS: ColumnDef<ShipmentContent, unknown>[] = [
  {
    accessorKey: "spot_id",
    header: "Spot ID",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-[#FF7026] font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "container_ref",
    header: "Container",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-[#9ca3af]">{(getValue() as string | null) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "sku",
    header: "SKU",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-[#e5e5e5]">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "product_name",
    header: "Product",
    cell: ({ getValue }) => (
      <span className="text-sm text-[#9ca3af] max-w-[180px] truncate block">
        {(getValue() as string | null) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "qty",
    header: "Qty",
    cell: ({ getValue }) => (
      <span className="text-sm font-bold text-white tabular-nums">{getValue() as number}</span>
    ),
  },
  {
    accessorKey: "depot_destination",
    header: "Depot",
    cell: ({ getValue }) => {
      const code = getValue() as string | null;
      if (!code) return <span className="text-[#4b5563]">—</span>;
      return (
        <span className="text-[10px] px-2 py-0.5 rounded bg-[#1e2a3a] border border-blue-900/50 text-blue-300 font-mono">
          {code}
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
  },
  {
    accessorKey: "shipped_at",
    header: "Shipped",
    cell: ({ getValue }) => (
      <span className="text-xs text-[#4b5563]">{formatDate(getValue() as string | null)}</span>
    ),
  },
  {
    accessorKey: "eta",
    header: "ETA",
    cell: ({ getValue }) => {
      const date = getValue() as string | null;
      if (!date) return <span className="text-[#4b5563]">—</span>;
      const daysLeft = Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
      const color = daysLeft < 0 ? "text-red-300" : daysLeft < 7 ? "text-yellow-300" : "text-emerald-300";
      return (
        <div>
          <p className="text-xs text-[#e5e5e5]">{formatDate(date)}</p>
          <p className={`text-[10px] ${color}`}>
            {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : daysLeft === 0 ? "Today" : `${daysLeft}d`}
          </p>
        </div>
      );
    },
  },
  {
    accessorKey: "po_reference",
    header: "PO Ref",
    cell: ({ getValue }) => (
      <span className="font-mono text-[10px] text-[#4b5563]">{(getValue() as string | null) ?? "—"}</span>
    ),
  },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-[#9ca3af] mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026] transition-colors";

const selectCls =
  "w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-[#e5e5e5] focus:outline-none focus:border-[#FF7026] transition-colors";

export default function ShippingClient({ items }: { items: ShipmentContent[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AddShipmentInput>(EMPTY_FORM);
  const [lookupRef, setLookupRef] = useState("");
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "found" | "not_found">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function set<K extends keyof AddShipmentInput>(key: K, value: AddShipmentInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openModal() {
    setForm(EMPTY_FORM);
    setLookupRef("");
    setLookupStatus("idle");
    setSubmitError(null);
    setOpen(true);
  }

  async function handleLookup() {
    if (!lookupRef.trim()) return;
    setLookupStatus("loading");
    const result = await lookupCargoPartnerShipment(lookupRef.trim());
    if (result.found) {
      setLookupStatus("found");
      setForm((prev) => ({
        ...prev,
        spot_id: lookupRef.trim(),
        container_ref: result.container_ref ?? prev.container_ref,
        eta: result.eta ?? prev.eta,
        shipped_at: result.shipped_at ?? prev.shipped_at,
      }));
    } else {
      setLookupStatus("not_found");
      setForm((prev) => ({ ...prev, spot_id: lookupRef.trim() }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    startTransition(async () => {
      const result = await addShipment(form);
      if ("error" in result) {
        setSubmitError(result.error);
      } else {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-[#4b5563]">{items.length} shipment line{items.length !== 1 ? "s" : ""}</p>
        <button
          onClick={openModal}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#FF7026] hover:bg-[#f2641b] text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Shipment
        </button>
      </div>

      {items.length > 0 ? (
        <BoardTable
          data={items}
          columns={COLUMNS}
          searchPlaceholder="Search Spot ID, container, SKU..."
          emptyMessage="No shipments found"
        />
      ) : (
        <div className="border border-dashed border-[#2a2a2a] rounded-xl p-16 text-center">
          <p className="text-[#4b5563] mb-2">No shipments tracked yet</p>
          <p className="text-xs text-[#3a3a3a]">
            Add a shipment above using a SPOT ID or reference number
          </p>
        </div>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg max-h-[90vh] overflow-y-auto bg-[#141414] border border-[#2a2a2a] rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-lg font-semibold text-white" style={{ fontFamily: "Varela Round, sans-serif" }}>
                Add Shipment
              </Dialog.Title>
              <Dialog.Close className="p-1.5 text-[#4b5563] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>

            {/* Cargo Partner lookup */}
            <div className="bg-[#1a1a2e] border border-blue-900/30 rounded-xl p-4 mb-5">
              <p className="text-xs text-blue-300 font-medium mb-2">Cargo Partner Lookup (optional)</p>
              <p className="text-[10px] text-[#4b5563] mb-3">
                Enter a SPOT ID or reference number to auto-fill container and ETA details.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={lookupRef}
                  onChange={(e) => setLookupRef(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleLookup(); } }}
                  placeholder="e.g. SN24090000233"
                  className={inputCls + " flex-1"}
                />
                <button
                  type="button"
                  onClick={handleLookup}
                  disabled={lookupStatus === "loading" || !lookupRef.trim()}
                  className="px-3 py-2 bg-blue-900/50 hover:bg-blue-800/60 border border-blue-900/50 text-blue-300 text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
                >
                  {lookupStatus === "loading" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  Look Up
                </button>
              </div>
              {lookupStatus === "found" && (
                <p className="text-[10px] text-emerald-400 mt-2">Found — container and ETA pre-filled below.</p>
              )}
              {lookupStatus === "not_found" && (
                <p className="text-[10px] text-yellow-400 mt-2">Not found via API — fill in the details manually.</p>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="SPOT ID *">
                  <input
                    required
                    type="text"
                    value={form.spot_id}
                    onChange={(e) => set("spot_id", e.target.value)}
                    placeholder="SN24090000233"
                    className={inputCls}
                  />
                </Field>
                <Field label="Container Ref">
                  <input
                    type="text"
                    value={form.container_ref ?? ""}
                    onChange={(e) => set("container_ref", e.target.value)}
                    placeholder="MSCU1234567"
                    className={inputCls}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="SKU *">
                  <select
                    required
                    value={form.sku}
                    onChange={(e) => set("sku", e.target.value)}
                    className={selectCls}
                  >
                    <option value="">Select SKU…</option>
                    {KNOWN_SKUS.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} — {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Quantity *">
                  <input
                    required
                    type="number"
                    min={1}
                    value={form.qty}
                    onChange={(e) => set("qty", parseInt(e.target.value, 10) || 1)}
                    className={inputCls}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Depot Destination *">
                  <select
                    required
                    value={form.depot_destination}
                    onChange={(e) => set("depot_destination", e.target.value as AddShipmentInput["depot_destination"])}
                    className={selectCls}
                  >
                    {DEPOT_OPTIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Status *">
                  <select
                    required
                    value={form.status}
                    onChange={(e) => set("status", e.target.value as AddShipmentInput["status"])}
                    className={selectCls}
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s.replace("_", " ")}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Shipped Date">
                  <input
                    type="date"
                    value={form.shipped_at ?? ""}
                    onChange={(e) => set("shipped_at", e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label="ETA">
                  <input
                    type="date"
                    value={form.eta ?? ""}
                    onChange={(e) => set("eta", e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>

              <Field label="PO Reference">
                <input
                  type="text"
                  value={form.po_reference ?? ""}
                  onChange={(e) => set("po_reference", e.target.value)}
                  placeholder="e.g. PO-01001"
                  className={inputCls}
                />
              </Field>

              {submitError && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">
                  {submitError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Dialog.Close className="px-4 py-2 text-sm text-[#6b7280] hover:text-white transition-colors rounded-lg hover:bg-[#2a2a2a]">
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#FF7026] hover:bg-[#f2641b] text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Add Shipment
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
