import type { ReactNode } from "react";

// Consistent empty/zero-data state. `dark` matches the ERP module surface (#111);
// light is the dashboard/quotes shell. Pass an optional icon + a call-to-action.
export function EmptyState({
  icon,
  title,
  description,
  action,
  dark = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  dark?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center rounded-xl border border-dashed px-6 py-14 ${
        dark ? "border-[#2a2a2a]" : "border-gray-200"
      }`}
    >
      {icon && <div className={`mb-3 ${dark ? "text-[#4b5563]" : "text-gray-300"}`}>{icon}</div>}
      <p className={`text-sm font-semibold ${dark ? "text-[#e5e5e5]" : "text-gray-700"}`}>{title}</p>
      {description && (
        <p className={`text-xs mt-1.5 max-w-sm ${dark ? "text-[#6b7280]" : "text-gray-500"}`}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
