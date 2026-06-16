/**
 * Per-user capability model — the Hub's RBAC catalogue.
 *
 * Capabilities answer "WHICH ACTIONS / MODULES" a user may touch. They are
 * orthogonal to row-scoping (which the `profiles` table answers: `pipeline_id`
 * = region, `allowed_depots`, `is_super_admin`). A user is granted capabilities
 * per-user via the `user_capabilities` table; the UI gates nav + buttons by the
 * user's set, and RLS + server actions enforce the same set server-side.
 *
 * The `admin` capability (and `profiles.is_super_admin`) implies ALL capabilities.
 *
 * This module is pure data/types — safe to import from both client and server.
 * DB-reading helpers live in `@/lib/authz` (server-only).
 */

export const CAPABILITY_KEYS = [
  'quotes.view',
  'quotes.create',
  'po.view',
  'po.create',
  'po.approve',
  'bom.view',
  'bom.edit',
  'transport.view',
  'mrp.view',
  'stock.edit',
  'admin',
] as const

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export interface CapabilityMeta {
  key: CapabilityKey
  module: string
  description: string
}

/** Catalogue seeded into the `capabilities` reference table (keep in sync). */
export const CAPABILITIES: CapabilityMeta[] = [
  { key: 'quotes.view', module: 'quotes', description: 'View quotes and the deals pipeline' },
  { key: 'quotes.create', module: 'quotes', description: 'Create and send quotes (sets probability of close)' },
  { key: 'po.view', module: 'purchase-orders', description: 'View purchase orders' },
  { key: 'po.create', module: 'purchase-orders', description: 'Raise purchase orders (pre-approval)' },
  { key: 'po.approve', module: 'purchase-orders', description: 'Approve / authorise purchase orders' },
  { key: 'bom.view', module: 'bom', description: 'View the bill of materials and pricing' },
  { key: 'bom.edit', module: 'bom', description: 'Edit master BOM component prices/details (saved to the mfg snapshot)' },
  { key: 'transport.view', module: 'transport', description: 'View shipments and transport tracking' },
  { key: 'mrp.view', module: 'mrp', description: 'View the MRP reorder/manufacturing dashboard' },
  { key: 'stock.edit', module: 'mrp', description: 'Override warehouse stock levels (the dummy-stock override path)' },
  { key: 'admin', module: 'admin', description: 'Full administrative access (implies all capabilities)' },
]

export interface NavItem {
  label: string
  href: string
  /** Lucide icon name — resolved in the sidebar component. */
  icon: string
  /** The user must hold at least one of these capabilities to see/visit this item. */
  requires: CapabilityKey[]
}

/** Sidebar navigation — one entry per workstream, gated by capability. */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: 'LayoutDashboard', requires: [] },
  { label: 'Quotes', href: '/quotes', icon: 'FileText', requires: ['quotes.view', 'quotes.create'] },
  { label: 'Purchase Orders', href: '/purchase-orders', icon: 'ShoppingCart', requires: ['po.view', 'po.create', 'po.approve'] },
  { label: 'Bill of Materials', href: '/bom', icon: 'Layers', requires: ['bom.view'] },
  { label: 'Transport', href: '/transport', icon: 'Truck', requires: ['transport.view'] },
  { label: 'MRP', href: '/mrp', icon: 'Gauge', requires: ['mrp.view'] },
]

/** True if `caps` satisfies the requirement list (empty list = always visible). */
export function satisfiesRequirement(caps: Set<CapabilityKey>, requires: CapabilityKey[]): boolean {
  if (caps.has('admin')) return true
  if (requires.length === 0) return true
  return requires.some((r) => caps.has(r))
}
