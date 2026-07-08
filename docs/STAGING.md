# Echo Barrier Hub — Staging (sandbox) environment

A hands-on test build for Juraj, Dave, Martin and their accountant to trial the Hub
and log bugs — **isolated from every production platform**. This doc is the runbook
to stand it up.

## Isolation model (why it's safe)

Two independent layers, so a single mistake can't leak into production:

1. **Config isolation** — the staging site leaves the HubSpot / n8n / Cargo / mfg
   credentials **blank** (`.env.staging.example`), so no external platform is reachable.
   > **Decision (Dean, 2026-07-08): reuse the EXISTING Supabase project**, not a separate
   > one. Testers only ever get **Hub logins** (never Supabase access), so RLS + capability
   > scoping keep the quotes/deals out of view, and the kill switch keeps Xero/HubSpot/Cargo
   > untouched. Trade-off accepted: testers' POs/invoices land in the shared prod DB
   > alongside real rows (test data, but no external side effects).
2. **In-code kill switch** — `NEXT_PUBLIC_HUB_ENV=staging` flips
   `externalCallsDisabled()` (`src/lib/env.ts`), which hard-blocks **every** outbound
   call to Xero(via n8n), HubSpot, Cargo Partner and the manufacturing Supabase —
   **even if a production token is mis-pasted** into the staging env. Proven by
   `tests/unit/staging-guard.test.ts`.

The **same codebase** serves production and staging — staging is just this repo
deployed to a second Netlify site with the flag on. No code fork.

A persistent amber **"STAGING SANDBOX"** banner shows on every page so testers always
know they're not in production and that the Hub is still in build.

## What's testable in staging vs held back

| Module | In staging | Notes |
|---|---|---|
| **PO raise → 3-tier approval** | ✅ fully | Supabase-backed. Xero hand-off is skipped (banner note on approve). |
| **BOM explosion / master prices** | ⚠️ view only | Needs a (read-only) mfg URL to render; price **edits are blocked**. Leave mfg blank for full isolation. |
| **Commercial invoices** | ✅ generate + PDF | Fully Supabase-backed; no external push. This is the main thing for the accountant to poke. |
| **Transport / Cargo lookup** | ⛔ disabled | Cargo API is off in staging (kill switch). |
| **Quotes** | ⛔ limited | The quote flow lives in the **live HubSpot CRM**; with no token it's inert. To test Quotes, wire a HubSpot **sandbox** portal later — never prod. |

> Tell testers plainly: **the Hub is not yet complete end-to-end** — this is an early
> sandbox to react to the flow and surface issues, not a finished system.

## Stand-up steps

### 1. Supabase — reuse the existing prod ops project (Dean's decision)
- Point the staging site at the **existing** ops project `korylyniwsqtsvzuzydg` — the
  SAME `NEXT_PUBLIC_SUPABASE_URL` / anon / service_role keys as the live Hub. No new
  project, no migration replay (every migration is already applied there).
- Testers get **Hub logins only** (Supabase Auth users) — never Supabase project access —
  so they interact solely through the capability-gated, RLS-enforced UI. Scoped users can't
  see the quotes/deals, and the kill switch blocks every external platform.
- No separate seed needed: the composition demo rules (Brazil / CS Enclosure) are already
  seeded in prod ops. Testers exercise real containers/POs.

### 2. GitHub + Netlify
- Push a **`staging` branch** (or reuse `main`) to GitHub.
- Create a **second Netlify site** from the repo, tracking that branch.
- Set env vars: `NEXT_PUBLIC_HUB_ENV=staging`, the **prod ops** Supabase URL + anon +
  service_role keys (same as the live Hub), and leave HubSpot / n8n / Cargo / mfg **blank**.
- Point it at a staging domain (e.g. `staging-hub.echobarrier.com` via Cloudflare
  grey-cloud CNAME, or just the `*.netlify.app` URL).

### 3. Supabase auth URLs
- In the (shared) Supabase project → Authentication → URL config, ADD the staging site
  URL to the **Redirect URLs** allow-list (alongside the live Hub's), so invite/onboarding
  links resolve for the staging domain too.

### 4. Invite the testers (uses the existing invite + onboarding flow)
The Hub already has an invite → onboarding flow: an invited user gets an email, lands
on `/onboarding`, sets their name + (for sales users) region + password. **Capabilities
are NOT granted at onboarding** — grant them per-user afterwards (there's no admin UI
yet, so it's a service-role SQL step).

1. Invite each of the four by email (Supabase Studio → Authentication → Users → *Invite*,
   on the **staging** project).
2. After they onboard (or immediately, keyed by email), grant capabilities — see the
   per-persona SQL below.

### 5. Grant capabilities (per persona)

```sql
-- Run in the STAGING Supabase SQL editor. Grants are keyed by email so you can run
-- this before or after each person finishes onboarding.
-- Personas:
--   Juraj, Dave  → full operator (raise + approve POs, BOM, transport, invoices, prices)
--   Martin       → full operator (same as Juraj)
--   Accountant   → invoices + costs + PO read (financials, no editing)
with grants(email, capability) as (
  values
    -- Juraj (SRO)
    ('juraj@echobarrier.eu', 'po.view'), ('juraj@echobarrier.eu', 'po.create'),
    ('juraj@echobarrier.eu', 'po.approve'), ('juraj@echobarrier.eu', 'bom.view'),
    ('juraj@echobarrier.eu', 'bom.edit'), ('juraj@echobarrier.eu', 'transport.view'),
    ('juraj@echobarrier.eu', 'invoice.view'), ('juraj@echobarrier.eu', 'invoice.create'),
    ('juraj@echobarrier.eu', 'cost.view'),
    -- Dave
    ('dave@echobarrier.eu', 'po.view'), ('dave@echobarrier.eu', 'po.create'),
    ('dave@echobarrier.eu', 'po.approve'), ('dave@echobarrier.eu', 'bom.view'),
    ('dave@echobarrier.eu', 'transport.view'), ('dave@echobarrier.eu', 'invoice.view'),
    ('dave@echobarrier.eu', 'invoice.create'), ('dave@echobarrier.eu', 'cost.view'),
    -- Martin
    ('martin@echobarrier.eu', 'po.view'), ('martin@echobarrier.eu', 'po.create'),
    ('martin@echobarrier.eu', 'po.approve'), ('martin@echobarrier.eu', 'bom.view'),
    ('martin@echobarrier.eu', 'bom.edit'), ('martin@echobarrier.eu', 'transport.view'),
    ('martin@echobarrier.eu', 'invoice.view'), ('martin@echobarrier.eu', 'invoice.create'),
    ('martin@echobarrier.eu', 'cost.view'),
    -- External accountant (financial view only)
    ('accountant@example.com', 'po.view'), ('accountant@example.com', 'bom.view'),
    ('accountant@example.com', 'invoice.view'), ('accountant@example.com', 'cost.view')
)
insert into public.user_capabilities (user_id, capability)
select u.id, g.capability
from grants g
join auth.users u on lower(u.email) = lower(g.email)
on conflict (user_id, capability) do nothing;
```

> Replace the placeholder emails with the real invited addresses. `cost.view` is what
> lets a persona see prices; omit it to give a price-blind view. `admin` is NOT granted
> to testers.

## Notes / gotchas
- The kill switch keys on `NEXT_PUBLIC_HUB_ENV` — make sure it's set to exactly
  `staging` on the staging site and **unset (or `production`)** on the live site.
- Because the same repo serves both, a production deploy is unaffected: with the flag
  absent, `externalCallsDisabled()` is `false` and behaviour is unchanged.
- If you later want a HubSpot sandbox in staging, set a **sandbox** token — the kill
  switch still blocks writes, so flip it off only for HubSpot if you deliberately want
  sandbox writes (would need a small change; ask first).
