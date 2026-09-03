import {
  LayoutDashboard,
  FileText,
  ReceiptText,
  Tags,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
  type LucideIcon,
} from 'lucide-react'
import type { NavIconName } from '@/lib/capabilities'

/**
 * The one place a nav icon name becomes a component.
 *
 * The sidebar and the dashboard home each carried their own copy of this map,
 * with different fallbacks: an unknown name drew a dashboard glyph in the
 * sidebar and a document glyph on the home page. Both fell back silently, so
 * adding a nav item and forgetting one map looked like a design choice rather
 * than a bug.
 *
 * Typed as a complete Record, so a name in NAV_ICON_NAMES with no entry here
 * fails the build. That is why there is no fallback: there is no longer a case
 * where the lookup can miss.
 */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  LayoutDashboard,
  FileText,
  ReceiptText,
  Tags,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
}
