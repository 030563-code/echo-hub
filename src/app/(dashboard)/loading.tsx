import { PageSkeleton } from "@/components/ui/loading-skeleton";

// Fallback for the light dashboard shell (dashboard home + Quotes). Dark ERP
// modules override this with their own loading.tsx.
export default function Loading() {
  return <PageSkeleton />;
}
