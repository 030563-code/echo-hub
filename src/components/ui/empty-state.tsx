import type { ReactNode } from "react";

// Consistent empty/zero-data state. Pass an optional icon + a call-to-action.
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center rounded-xl border border-dashed px-6 py-14 border-gray-200">
      {icon && <div className="mb-3 text-gray-300">{icon}</div>}
      <p className="text-sm font-semibold text-gray-700">{title}</p>
      {description && (
        <p className="text-xs mt-1.5 max-w-sm text-gray-500">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
