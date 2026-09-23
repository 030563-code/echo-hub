import 'server-only'

/**
 * What the RUNNING server can actually see, by name.
 *
 * Dean, 17 Sep 2026: "Why when I click on the Send to Bamida it says The Bamida webhook is not
 * configured on the server. But N8N_BAMIDA_PO_WEBHOOK_URL is on the Netlify server?"
 *
 * A fair question with no way to answer it from outside. A variable can be present in the Netlify
 * UI and absent from the function that reads it, for three reasons that all look identical from a
 * browser: it is scoped to Builds and not to Functions, it is set on a different deploy context
 * than the one serving the site, or it was added after the last deploy and no build has happened
 * since. This turns "it is not configured" into "here is exactly what the process holds".
 *
 * 🔴 PRESENCE AND HOST ONLY. NEVER A VALUE.
 *
 * Reading an environment is how secrets end up in a screenshot, a support thread or a transcript.
 * Every entry returns a boolean, and for a URL the HOST only: enough to see whether it points at
 * n8n at all, and useless to anybody who sees it over a shoulder. `tests/unit/server-config.test.ts`
 * fails if a value can ever reach the page.
 */

export type ConfigGroup = 'Manufacturing' | 'Transport' | 'Invoicing' | 'Email' | 'Platform'

export interface ConfigEntry {
  name: string
  group: ConfigGroup
  /** What stops working when it is missing. Written for whoever is reading the page at the time. */
  breaks: string
  /** True when the Hub refuses the action outright rather than degrading. */
  required: boolean
  present: boolean
  /** For a URL, the host it points at. Never the path, which is the part worth guessing at. */
  host: string | null
}

const SPEC: Array<Omit<ConfigEntry, 'present' | 'host'> & { url?: boolean }> = [
  { name: 'N8N_BAMIDA_PO_WEBHOOK_URL', group: 'Manufacturing', required: true, url: true,
    breaks: 'Send to Bamida refuses with "The Bamida webhook is not configured on the server."' },
  { name: 'N8N_BAMIDA_PO_WEBHOOK_SECRET', group: 'Manufacturing', required: false,
    breaks: 'n8n answers 401 and the send hands its claim back, so the order can be sent again.' },
  { name: 'BAMIDA_PASSWORD', group: 'Manufacturing', required: false,
    breaks: 'The factory emails go out without the sign-in block. Everything else is unchanged.' },
  { name: 'BAMIDA_PO_BCC', group: 'Manufacturing', required: false,
    breaks: 'Nobody is blind copied on an order. Optional by design.' },

  { name: 'N8N_SRO_NOTIFY_WEBHOOK_URL', group: 'Manufacturing', required: true, url: true,
    breaks: 'Approving a depot order tells nobody it has reached EB SRO.' },
  { name: 'N8N_SRO_NOTIFY_WEBHOOK_SECRET', group: 'Manufacturing', required: false,
    breaks: 'n8n answers 401 and the notification is skipped.' },

  { name: 'N8N_CARGO_NOTIFY_WEBHOOK_URL', group: 'Transport', required: true, url: true,
    breaks: 'Ready for shipment and the collection request reach nobody.' },
  { name: 'N8N_CARGO_NOTIFY_WEBHOOK_SECRET', group: 'Transport', required: false,
    breaks: 'n8n answers 401 and the request is not sent.' },
  { name: 'CARGO_NOTIFY_TO', group: 'Transport', required: false,
    breaks: 'The collection request has no default recipient and the screen must be filled in.' },
  { name: 'CARGO_NOTIFY_CC', group: 'Transport', required: false, breaks: 'No default copy.' },
  { name: 'CUSTOMS_INGEST_SECRET', group: 'Transport', required: true,
    breaks: "n8n cannot hand the Hub a Nippon Express PDF or Claude's reading of one; both are refused with 401." },
  { name: 'N8N_CUSTOMS_WEBHOOK_URL', group: 'Transport', required: true, url: true,
    breaks: 'A Nippon Express invoice is stored but never read, and no draft bill reaches Xero.' },
  { name: 'N8N_CUSTOMS_WEBHOOK_SECRET', group: 'Transport', required: false,
    breaks: 'n8n answers 401 and the customs step (reading, draft bill, approval) does not run.' },

  { name: 'N8N_PO_APPROVED_WEBHOOK_URL', group: 'Invoicing', required: true, url: true,
    breaks: 'Approving a purchase order no longer creates it in Xero.' },
  { name: 'N8N_PO_APPROVED_WEBHOOK_SECRET', group: 'Invoicing', required: false,
    breaks: 'n8n answers 401 and no Xero order is made.' },
  { name: 'N8N_XERO_PO_ATTACH_WEBHOOK_URL', group: 'Invoicing', required: false, url: true,
    breaks: 'The PDF is not attached to the Xero purchase order.' },
  { name: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL', group: 'Invoicing', required: true, url: true,
    breaks: 'Customer invoices cannot be emailed.' },
  { name: 'N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET', group: 'Invoicing', required: false,
    breaks: 'n8n answers 401 and the invoice is not sent.' },
  // France posts to a DIFFERENT n8n workflow: Echo Barrier SAS is a different
  // Xero organisation, and the USA workflow carries its tenant id in ten nodes.
  // Not required until Claire is live; while unset, every French invoice action
  // refuses with a sentence rather than posting into the USA ledger.
  { name: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL_FR', group: 'Invoicing', required: false, url: true,
    breaks: 'French invoices cannot be priced in, or sent to, Xero.' },
  { name: 'N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET_FR', group: 'Invoicing', required: false,
    breaks: 'n8n answers 401 and the French invoice is not sent.' },

  { name: 'READY_NOTIFY_TO', group: 'Email', required: false,
    breaks: 'Ready-for-shipment falls back to its built-in recipient.' },
  { name: 'READY_NOTIFY_CC', group: 'Email', required: false, breaks: 'No internal copy.' },
  { name: 'HUB_EMAIL_TEST_RECIPIENT', group: 'Email', required: false,
    breaks: 'NOTHING BREAKS. While this is SET, every outbound email goes here instead of to the real recipient. Unset it only when you mean to reach people outside the building.' },

  { name: 'NEXT_PUBLIC_HUB_BASE_URL', group: 'Platform', required: false, url: true,
    breaks: 'Links in emails fall back to https://hub.echobarrier.com.' },
  { name: 'NEXT_PUBLIC_HUB_ENV', group: 'Platform', required: false,
    breaks: 'Set to "staging" the Hub contacts nothing outside itself. Anything else is production.' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', group: 'Platform', required: true,
    breaks: 'Almost everything: purchase orders, stock and the factory pages all read with it.' },
  { name: 'NEXT_PUBLIC_SUPABASE_URL', group: 'Platform', required: true, breaks: 'No database at all.' },
]

/** The host of a URL, or null. Never the path: that is the part a webhook keeps private. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host
  } catch {
    // Present but not a URL, which is itself worth seeing.
    return 'not a URL'
  }
}

/**
 * Read the environment the way the code that needs it does.
 *
 * 🔴 `process.env[name]` with a computed name is DELIBERATE and only safe because `name` comes from
 * SPEC above and never from a caller. Nothing here takes an argument.
 */
export function serverConfig(): ConfigEntry[] {
  return SPEC.map(({ url, ...entry }) => {
    const raw = String(process.env[entry.name] ?? '').trim()
    return { ...entry, present: raw.length > 0, host: url && raw ? hostOf(raw) : null }
  })
}

/** The required entries that are missing, which is the only thing most readers want. */
export function missingRequired(entries: readonly ConfigEntry[]): ConfigEntry[] {
  return entries.filter((e) => e.required && !e.present)
}
