# Echo Barrier Hub

Echo Barrier's unified internal operating platform — one app, single login per
user, **per-user capability-based access**, a page per workstream
(Quotes · Purchase Orders · BOM · Transport · Weeklies). See [`CLAUDE.md`](./CLAUDE.md)
for the full architecture and the security rules.

## Stack
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Radix · Supabase.

## Access model — capabilities × scope
Two orthogonal axes:

- **Capability** (which actions/modules): the `user_capabilities` table, granted
  per user. Catalogue in [`src/lib/capabilities.ts`](./src/lib/capabilities.ts);
  nav + pages gate on it via [`src/lib/authz.ts`](./src/lib/authz.ts) and RLS
  enforces it via `public.has_capability()`. `admin` / `is_super_admin` imply all.
- **Scope** (which rows): `profiles.pipeline_id` (region) + `allowed_depots`.
  Quotes are scoped by region.

Example — **Jillian (US)**: `quotes.view` + `quotes.create` + `po.create`
(NOT `po.approve`), `pipeline_id` = USA SALES.

## Security (non-negotiable)
- RLS on every table from day 1. Anon/publishable key client-side only;
  **service-role key server-side only, never committed**.
- Authorize every server action server-side (capability + ownership); never trust
  a client-supplied id/role. The capability-write path is the service-role client
  behind a server-side admin check — `authenticated` has no write grant on
  `user_capabilities` (escalation defense).

## Local dev
```bash
cp .env.local.example .env.local   # fill with the ROTATED keys (never commit)
npm install
npm run dev
```
`npm run typecheck` · `npm run lint` · `npm test` · `npm run build` all run in CI,
plus a Supabase migration-drift guard (fails if live schema ≠ supabase/migrations).

## Database migrations
- `20260612000000_hub_capability_model.sql` — **additive**: capabilities,
  user_capabilities, `has_capability()`, backfill. Safe to apply anytime.
- `20260612000100_hub_deals_capability_scope.sql` — **staged**: switches
  `deals_registry` RLS to capability + region scoping. Shared DB with the live
  sales-hub → **do not merge to prod until Phase 5 / Quotes sign-off** (see the
  file header for preconditions).

Project: `korylyniwsqtsvzuzydg` (ops, "Hubspot Shipping and Stocks").
