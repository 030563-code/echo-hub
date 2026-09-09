import { formatRelative } from "@/lib/utils";

/** Shared by the purchase order board drawer and the single order page, so it is not re-inlined. */
export default function TimelineItem({ label, date, by }: { label: string; date: string; by?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="w-1.5 h-1.5 rounded-full bg-echo-orange mt-1 flex-shrink-0" />
      <div>
        <span className="text-gray-600">{label}</span>
        <span className="text-gray-400 ml-1">{formatRelative(date)}</span>
        {by && <span className="text-gray-400 ml-1">by {by}</span>}
      </div>
    </div>
  );
}
