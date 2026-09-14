import { poNumberPurpose } from "@/lib/po-number";

/**
 * What an s.r.o. document is for, beside its number: EBSRO8001-1 reads
 * Manufacturing, -2 Shipping, -3 Accounting. Renders nothing for any other
 * number. No state and no browser APIs, so the server page and client lists
 * share it.
 */
export default function PoPurposeTag({ poNumber }: { poNumber: string | null | undefined }) {
  const purpose = poNumberPurpose(poNumber);
  if (!purpose) return null;
  return (
    <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-gray-600">
      {purpose}
    </span>
  );
}
