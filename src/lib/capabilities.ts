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
  'invoicing.view',
  'invoicing.manage',
  'pricing.view',
  'pricing.manage',
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
  { key: 'invoicing.view', module: 'invoicing', description: 'View the US accepted-quotes queue and draft invoices' },
  { key: 'invoicing.manage', module: 'invoicing', description: 'Edit drafts, calculate tax, and authorize US customer invoices' },
  { key: 'pricing.view', module: 'pricing', description: 'See list prices, contract prices and own discount cap' },
  { key: 'pricing.manage', module: 'pricing', description: 'Edit list prices, contractors, contract prices and rep discount caps' },
  { key: 'admin', module: 'admin', description: 'Full administrative access (implies all capabilities)' },
]

/**
 * The sidebar's section headings, in the order they appear.
 *
 * Dean asked for "main headings and a sorted navbar": Operations holding
 * Purchase Orders, Bill of Materials, Transport and MRP, and Sales and
 * Accounting holding Quotes, Invoicing and Pricing.
 *
 * A heading is presentation only. It never grants or denies anything, and a
 * group whose every item is gated away renders nothing at all, heading
 * included, so a rep is not shown the name of a section they cannot open.
 */
export const NAV_GROUPS = ['Sales and Accounting', 'Operations'] as const

export type NavGroup = (typeof NAV_GROUPS)[number]

/**
 * The Lucide icons the nav is allowed to use.
 *
 * A closed list rather than a free string, because both the sidebar and the
 * dashboard home resolve `icon` through a map. Each used to keep its own map
 * with its own silent `??` fallback, so a typo rendered the wrong icon in one
 * place and a different wrong icon in the other. Typing the shared map in
 * nav-icons.ts as Record<NavIconName, LucideIcon> turns that into a compile
 * error instead.
 */
export const NAV_ICON_NAMES = [
  'LayoutDashboard',
  'FileText',
  'ReceiptText',
  'Tags',
  'ShoppingCart',
  'Layers',
  'Truck',
  'Gauge',
] as const

export type NavIconName = (typeof NAV_ICON_NAMES)[number]

export interface NavItem {
  label: string
  href: string
  /** Resolved through NAV_ICONS in src/lib/nav-icons.ts. */
  icon: NavIconName
  /** The user must hold at least one of these capabilities to see/visit this item. */
  requires: CapabilityKey[]
  /** The heading this sits under. Omitted for top-level items such as
   *  Dashboard, which render above every group. */
  group?: NavGroup
}

/**
 * Sidebar navigation — one entry per workstream, gated by capability.
 *
 * Order within a group is Dean's, not alphabetical: Quotes, Invoicing, Pricing
 * follows the order the work actually happens in.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: 'LayoutDashboard', requires: [] },

  { label: 'Quotes', href: '/quotes', icon: 'FileText', requires: ['quotes.view', 'quotes.create'], group: 'Sales and Accounting' },
  { label: 'Invoicing', href: '/invoicing', icon: 'ReceiptText', requires: ['invoicing.view', 'invoicing.manage'], group: 'Sales and Accounting' },
  { label: 'Pricing', href: '/pricing', icon: 'Tags', requires: ['pricing.view', 'pricing.manage'], group: 'Sales and Accounting' },

  { label: 'Purchase Orders', href: '/purchase-orders', icon: 'ShoppingCart', requires: ['po.view', 'po.create', 'po.approve'], group: 'Operations' },
  { label: 'Bill of Materials', href: '/bom', icon: 'Layers', requires: ['bom.view'], group: 'Operations' },
  { label: 'Transport', href: '/transport', icon: 'Truck', requires: ['transport.view'], group: 'Operations' },
  { label: 'MRP', href: '/mrp', icon: 'Gauge', requires: ['mrp.view'], group: 'Operations' },
]

export interface NavSection {
  /** null for the ungrouped items that sit above every heading. */
  group: NavGroup | null
  items: NavItem[]
}

/**
 * The nav split into its sections, keeping only what `caps` can reach.
 *
 * Returns ungrouped items first, then each group in NAV_GROUPS order. A section
 * with no reachable items is dropped entirely rather than returned empty, so
 * callers never have to remember to check before rendering a heading.
 */
export function navSections(caps: Set<CapabilityKey>): NavSection[] {
  const visible = NAV_ITEMS.filter((item) => satisfiesRequirement(caps, item.requires))
  const sections: NavSection[] = []

  const ungrouped = visible.filter((item) => !item.group)
  if (ungrouped.length > 0) sections.push({ group: null, items: ungrouped })

  for (const group of NAV_GROUPS) {
    const items = visible.filter((item) => item.group === group)
    if (items.length > 0) sections.push({ group, items })
  }

  return sections
}

/** True if `caps` satisfies the requirement list (empty list = always visible). */
export function satisfiesRequirement(caps: Set<CapabilityKey>, requires: CapabilityKey[]): boolean {
  if (caps.has('admin')) return true
  if (requires.length === 0) return true
  return requires.some((r) => caps.has(r))
}
