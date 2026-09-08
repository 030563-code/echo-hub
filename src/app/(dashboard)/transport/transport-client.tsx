"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePageState } from "@/hooks/use-page-state";
import { DraftStrip } from "@/components/page-state/draft-strip";
import { TRANSPORT_ADD_SHIPMENT_KEY, parseShipmentDraft, type ShipmentDraft } from "@/lib/page-drafts";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { Plus, Search, X, Loader2, Ship } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import BoardTable from "@/components/board/BoardTable";
import StatusBadge from "@/components/board/StatusBadge";
import { formatDate } from "@/lib/utils";
import type { ShipmentContent } from "@/lib/erp-types";
import { groupBySpotId, type GroupedShipment } from "@/lib/shipment-grouping";
import ShipmentPanel from "./shipment-panel";
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

/**
 * The form's own shape: qty is held as free text so the box can be cleared and
 * retyped, and is coerced on submit. Held as a number with `parseInt || 1` it
 * was trapped on 1, because React skips updating a `type="number"` input when
 * the DOM string and the state number compare loosely equal.
 */
type ShipmentForm = Omit<AddShipmentInput, "qty"> & { qty: string };

const EMPTY_FORM: ShipmentForm = {
  spot_id: "",
  container_ref: "",
  sku: "",
  qty: "1",
  depot_destination: "US-BAL",
  status: "on_water",
  shipped_at: "",
  eta: "",
  po_reference: "",
};

/**
 * One row per shipment. shipment_contents stores a line per product, so a
 * container of four models used to fill four identical-looking rows and reading
 * the board meant recognising that four rows were one thing.
 */
const COLUMNS: ColumnDef<GroupedShipment, unknown>[] = [
  {
    accessorKey: "spotId",
    header: "Spot ID",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs font-medium text-echo-orange">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "containerRef",
    header: "Container",
    cell: ({ getValue }) => {
      const ref = getValue() as string | null;
      return ref ? (
        <span className="font-mono text-xs text-gray-600">{ref}</span>
      ) : (
        <span className="text-xs text-gray-400">split</span>
      );
    },
  },
  {
    id: "contents",
    header: "Contents",
    accessorFn: (row) => row.lines.map((l) => l.sku).join(" "),
    cell: ({ row }) => {
      const lines = row.original.lines;
      const first = lines[0];
      return (
        <div className="max-w-[240px]">
          <p className="truncate text-sm text-gray-900">
            {first?.product_name ?? first?.sku ?? "—"}
          </p>
          {lines.length > 1 && (
            <p className="text-xs text-gray-500">and {lines.length - 1} more</p>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "totalQty",
    header: "Units",
    cell: ({ getValue }) => (
      <span className="text-sm font-semibold tabular-nums text-gray-900">{getValue() as number}</span>
    ),
  },
  {
    accessorKey: "depot",
    header: "Depot",
    cell: ({ getValue }) => {
      const code = getValue() as string | null;
      if (!code) return <span className="text-xs text-gray-400">mixed</span>;
      return (
        <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[10px] text-blue-800">
          {code}
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => {
      const status = getValue() as string | null;
      return status ? <StatusBadge status={status} /> : <span className="text-gray-400">—</span>;
    },
  },
  {
    accessorKey: "shippedAt",
    header: "Shipped",
    cell: ({ getValue }) => (
      <span className="text-xs text-gray-500">{formatDate(getValue() as string | null)}</span>
    ),
  },
  {
    accessorKey: "eta",
    header: "ETA",
    cell: ({ getValue }) => {
      const date = getValue() as string | null;
      if (!date) return <span className="text-gray-400">—</span>;
      const daysLeft = Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
      const color = daysLeft < 0 ? "text-red-600" : daysLeft < 7 ? "text-amber-600" : "text-emerald-700";
      return (
        <div>
          <p className="text-xs text-gray-900">{formatDate(date)}</p>
          <p className={`text-[10px] ${color}`}>
            {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : daysLeft === 0 ? "Today" : `${daysLeft}d`}
          </p>
        </div>
      );
    },
  },
  {
    id: "poReferences",
    header: "PO Ref",
    accessorFn: (row) => row.poReferences.join(" "),
    cell: ({ row }) => {
      const refs = row.original.poReferences;
      if (refs.length === 0) return <span className="text-gray-400">—</span>;
      return (
        <span className="font-mono text-[10px] text-gray-500">
          {/* Every PO on the container, not just the first: a multi-PO container
              used to lose all but one. */}
          {refs.join(", ")}
        </span>
      );
    },
  },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors";

const selectCls =
  "w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-base sm:text-sm text-gray-900 focus:outline-none focus:border-echo-orange transition-colors";

export default function ShippingClient({ items }: { items: ShipmentContent[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GroupedShipment | null>(null);

  // useMemo, not a plain call: BoardTable memoises off the data reference, and
  // a fresh array on every keystroke in its search box resets the table.
  const shipments = useMemo(() => groupBySpotId(items), [items]);
  const [form, setForm] = useState<ShipmentForm>(EMPTY_FORM);
  const [lookupRef, setLookupRef] = useState("");
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "found" | "not_found">("idle");
  const [lookupInfo, setLookupInfo] = useState<{ spot_id?: string; vessel?: string; count?: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  /** Set once the user actually changes something, so a slow read cannot land
   *  on top of their typing. */
  const touchedRef = useRef(false);

  function set<K extends keyof ShipmentForm>(key: K, value: ShipmentForm[K]) {
    touchedRef.current = true;
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // ------------------------------------------------------------------
  // The saved draft. A container has nine fields plus a lookup, and closing the
  // dialog or leaving the page used to throw all of it away on purpose.
  // ------------------------------------------------------------------
  const seedDraftJson = JSON.stringify({ v: 1, form: EMPTY_FORM, lookupRef: "" });

  const {
    restored: restoredDraft,
    save: saveDraft,
    clear: clearDraft,
    saveStatus: draftSaveStatus,
    savedAt: draftSavedAt,
  } = usePageState<ShipmentDraft>({
    pageKey: TRANSPORT_ADD_SHIPMENT_KEY,
    parse: parseShipmentDraft,
    onRestore: (restored) => {
      // Only actual typing blocks a restore. Gating on the dialog being open
      // meant that clicking Add Shipment before the read landed skipped the
      // restore entirely, and the empty form then deleted the saved draft.
      if (!restored || touchedRef.current) return;
      setForm(restored.data.form);
      setLookupRef(restored.data.lookupRef);
    },
    isEmpty: (draft) => JSON.stringify(draft) === seedDraftJson,
  });

  useEffect(() => {
    saveDraft({ v: 1, form, lookupRef });
  }, [saveDraft, form, lookupRef]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setLookupRef("");
    setLookupStatus("idle");
    setLookupInfo(null);
    setSubmitError(null);
  }

  /** Throw the half-filled shipment away and start from an empty form. */
  const startAgain = async () => {
    await clearDraft();
    resetForm();
  };

  function openModal() {
    // Deliberately does NOT wipe the form any more. Resetting on every open is
    // the behaviour this feature exists to undo; the strip inside the dialog
    // says what was kept and offers the way out of it.
    setLookupStatus("idle");
    setLookupInfo(null);
    setSubmitError(null);
    setOpen(true);
  }

  async function handleLookup() {
    if (!lookupRef.trim()) return;
    setLookupStatus("loading");
    setLookupInfo(null);
    const result = await lookupCargoPartnerShipment(lookupRef.trim());
    if (result.found && result.spot_id) {
      setLookupStatus("found");
      setLookupInfo({ spot_id: result.spot_id, vessel: result.vessel, count: result.match_count });
      setForm((prev) => ({
        ...prev,
        spot_id: result.spot_id!, // the REAL SPOT ID auto-retrieved from the PO
        po_reference: lookupRef.trim(), // link the shipment back to the PO
        container_ref: result.container_ref ?? prev.container_ref,
        eta: result.eta ?? prev.eta,
        shipped_at: result.shipped_at ?? prev.shipped_at,
      }));
      toast.success(`SPOT ID ${result.spot_id} retrieved${result.vessel ? ` · vessel ${result.vessel}` : ""}`);
    } else {
      setLookupStatus("not_found");
      // The reference is a PO, not a SPOT ID — keep it as po_reference; leave the
      // SPOT ID for manual entry.
      setForm((prev) => ({ ...prev, po_reference: lookupRef.trim() }));
      if (result.error) toast.error(result.error);
      else toast("No Cargo Partner shipment for that PO yet — enter the SPOT ID manually.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    // Coerce at the boundary, and mirror the server's own rule so the message
    // names the field instead of returning a bare "Invalid input".
    const qty = Number(form.qty.trim());
    if (!Number.isInteger(qty) || qty < 1) {
      setSubmitError("Quantity must be a whole number of at least 1.");
      return;
    }
    startTransition(async () => {
      const result = await addShipment({ ...form, qty });
      if ("error" in result) {
        setSubmitError(result.error);
        toast.error(result.error);
      } else if (result.warning) {
        // Saved, but the reference didn't link to a PO — keep the dialog open so
        // the user sees the note (they can correct the reference or close).
        setSubmitError(`Saved. ${result.warning}`);
        router.refresh();
        toast.success("Shipment saved — check the PO reference note");
      } else {
        setOpen(false);
        // The shipment exists, so the draft that built it is spent.
        void clearDraft();
        resetForm();
        router.refresh();
        toast.success("Shipment added");
      }
    });
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">
          {shipments.length} shipment{shipments.length !== 1 ? "s" : ""}, {items.length} line
          {items.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={openModal}
          className="flex items-center gap-1.5 rounded-lg bg-echo-orange px-3 py-3 text-sm font-medium text-gray-900 transition-colors hover:bg-echo-orange-hover sm:py-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Shipment
        </button>
      </div>

      {shipments.length > 0 ? (
        <BoardTable
          dark={false}
          stateKey="transport:table"
          data={shipments}
          columns={COLUMNS}
          onRowClick={setSelected}
          searchPlaceholder="Search Spot ID, container, SKU, PO..."
          emptyMessage="No shipments found"
        />
      ) : (
        <EmptyState
          icon={<Ship className="w-7 h-7" />}
          title="No shipments tracked yet"
          description="Add a shipment above. Enter a PO number to retrieve its SPOT ID automatically."
        />
      )}

      {selected && <ShipmentPanel shipment={selected} onClose={() => setSelected(null)} />}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100%-2rem)] sm:w-full max-w-lg max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] overflow-y-auto bg-white border border-gray-200 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-lg font-semibold text-gray-900" style={{ fontFamily: "Varela Round, sans-serif" }}>
                Add Shipment
              </Dialog.Title>
              <Dialog.Close className="p-2.5 sm:p-1.5 text-gray-400 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>

            {/* Cargo Partner SPOT-ID auto-retrieve by PO number */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-5">
              <p className="text-xs text-blue-800 font-medium mb-2">Find shipment by PO number</p>
              <p className="text-[10px] text-gray-400 mb-3">
                Enter the PO number (general reference) — Cargo Partner&apos;s SPOT ID, container and ETA are retrieved automatically.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={lookupRef}
                  onChange={(e) => { touchedRef.current = true; setLookupRef(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleLookup(); } }}
                  placeholder="e.g. PO-00001364"
                  aria-label="PO number"
                  className={inputCls + " flex-1"}
                />
                <button
                  type="button"
                  onClick={handleLookup}
                  disabled={lookupStatus === "loading" || !lookupRef.trim()}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-700 border border-blue-600 text-gray-900 text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
                >
                  {lookupStatus === "loading" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  Retrieve
                </button>
              </div>
              {lookupStatus === "found" && (
                <p className="text-[10px] text-emerald-700 mt-2">
                  Found — SPOT ID <span className="font-mono">{lookupInfo?.spot_id}</span> retrieved
                  {lookupInfo?.vessel ? `, vessel ${lookupInfo.vessel}` : ""}; container + ETA pre-filled below.
                </p>
              )}
              {lookupStatus === "found" && (lookupInfo?.count ?? 1) > 1 && (
                <p className="text-[10px] text-amber-700 mt-1">
                  {lookupInfo?.count} shipments matched this PO — showing the first; verify it&apos;s the right one.
                </p>
              )}
              {lookupStatus === "not_found" && (
                <p className="text-[10px] text-amber-700 mt-2">No Cargo Partner shipment for that PO yet — enter the SPOT ID manually.</p>
              )}
            </div>

            {restoredDraft && (
              <div className="mb-4">
                <DraftStrip
                  what="the shipment you were adding"
                  savedAt={draftSavedAt}
                  onStartAgain={startAgain}
                  startAgainLabel="Clear this form"
                  saveStatus={draftSaveStatus}
                />
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="SPOT ID *">
                  <input
                    required
                    type="text"
                    value={form.spot_id}
                    onChange={(e) => set("spot_id", e.target.value)}
                    placeholder="auto-filled from the PO lookup"
                    aria-label="SPOT ID"
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    inputMode="numeric"
                    aria-label="Quantity"
                    value={form.qty}
                    onChange={(e) => set("qty", e.target.value)}
                    onBlur={(e) => { if (e.target.value.trim() === "") set("qty", "1"); }}
                    className={inputCls}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                <p className="text-red-700 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {submitError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Dialog.Close className="px-4 py-3 sm:py-2 text-sm text-gray-500 hover:text-gray-900 transition-colors rounded-lg hover:bg-gray-100">
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  className="px-4 py-3 sm:py-2 bg-echo-orange hover:bg-echo-orange-hover text-gray-900 text-sm font-medium rounded-lg transition-colors"
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
