"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/capabilities";

// Derives the current section's label from the pathname so the top header shows
// where you are (e.g. "Purchase Orders") instead of a static app name. Most
// specific match wins (longest href), so /purchase-orders/approvals → Purchase Orders.
export function PageTitle() {
  const pathname = usePathname();
  const item = [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(`${i.href}/`)));
  return (
    <h2 className="text-lg font-bold text-gray-800 uppercase tracking-wide truncate">
      {item?.label ?? "Echo Barrier Hub"}
    </h2>
  );
}
