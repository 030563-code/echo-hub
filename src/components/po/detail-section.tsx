/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
export default function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-1.5">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
