# Echo Barrier Hub — Deployment Guide

Move the Hub onto **Echo Barrier's GitHub**, deploy on **Echo Barrier's Netlify**,
and serve it at **quotes.echobarrier.com** via Cloudflare DNS.

> Placeholders to fill in: `<EB_GH>` = Echo Barrier's GitHub org/username ·
> `<SITE>` = the Netlify site name (e.g. `echo-barrier-hub`) → its auto URL is
> `https://<SITE>.netlify.app`.

The Supabase migrations (capability model + region scoping) are **already applied
to prod** — there is no DB step at deploy. Secrets live in Netlify env vars, never
in the repo.

---

## 0. Access you need first
- **GitHub:** owner/admin on the Echo Barrier GitHub org `<EB_GH>` (to create or
  receive a repo).
- **Netlify:** logged into the Echo Barrier Netlify account (sign in *with GitHub*
  using the Echo Barrier account so it can see the org's repos).
- **Cloudflare:** access to the `echobarrier.com` zone (this sits with **Tom** —
  get added, or have him make the one DNS record in step 3).
- **Env values:** the keys currently in your local `.env.local` (see step 2.3).

---

## 1. Repo → Echo Barrier's GitHub

The repo is currently at `github.com/deancorserv/echo-hub` (private). Two options:

### Option A — Transfer (keeps all history; recommended)
1. `github.com/deancorserv/echo-hub` → **Settings** → bottom **Danger Zone** →
   **Transfer ownership** → new owner = `<EB_GH>` → confirm.
2. An owner of `<EB_GH>` accepts the transfer (GitHub notification/email).
3. Repointing local git:
   ```bash
   cd echo-barrier-hub
   git remote set-url origin https://github.com/<EB_GH>/echo-hub.git
   git remote -v   # confirm
   ```

### Option B — Fresh repo under Echo Barrier (no history needed)
1. On `<EB_GH>`: **New repository** → name `echo-hub` → **Private** → do NOT
   initialise (no README/.gitignore).
2. Push:
   ```bash
   cd echo-barrier-hub
   git remote set-url origin https://github.com/<EB_GH>/echo-hub.git
   git push -u origin main
   ```

**Keep it PRIVATE.** Then enable GitHub → repo **Settings → Code security →
Secret scanning + Push protection** (cheap insurance after the last leak).

---

## 2. Netlify (Echo Barrier account)

### 2.1 Import the project
1. Netlify → **Add new site → Import an existing project → GitHub** → authorise
   Netlify for the `<EB_GH>` org → pick the `echo-hub` repo.
2. Build settings (Next.js auto-detected; `netlify.toml` in the repo pins them):
   - Build command: `npm run build`
   - The **@netlify/plugin-nextjs** runtime is added automatically for Next sites
     (gives SSR/middleware/Image support). Don't set a manual publish dir.
   - **Node 20** (set by `netlify.toml` / `NODE_VERSION=20`). Next 16 requires Node ≥20.9.
   - ⚠️ Next.js 16 is new — if the build errors on the Next version, ensure the
     latest Netlify Next runtime (Site config → Build → plugins), then redeploy.

### 2.2 Don't deploy yet — set env vars first
Site **Settings → Environment variables** → add all of these (same values as your
`.env.local`; mark the secret ones "Secret"). NEXT_PUBLIC_* are build-time, so add
them BEFORE the first successful build.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://korylyniwsqtsvzuzydg.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** — server only |
| `HUBSPOT_ACCESS_TOKEN` | **secret** — Quotes module |
| `NEXT_PUBLIC_HUBSPOT_PORTAL_ID` | deep-link after quote upload |
| `MFG_SUPABASE_URL` | `https://cdkpczinzhykcdbfoobn.supabase.co` (BOM) |
| `MFG_SUPABASE_SERVICE_ROLE_KEY` | **secret** — BOM module |
| `CARGO_PARTNER_USERNAME` / `_PASSWORD` / `_CLIENT_ID` / `_CLIENT_SECRET` | **secret** — Transport lookup |
| `N8N_ECHOBARRIER_API_KEY` / `N8N_INVITE_WEBHOOK_URL` | if/when the invite flow is wired |

Do **NOT** add the `E2E_*` vars — those are local test-only.

### 2.3 Deploy
**Deploys → Trigger deploy → Deploy site.** Note the `https://<SITE>.netlify.app`
URL and confirm it loads `/login`.

### 2.4 Tell Supabase about the new origin (commonly missed)
Supabase Dashboard → project `korylyniwsqtsvzuzydg` → **Authentication → URL
Configuration**:
- **Site URL:** `https://quotes.echobarrier.com`
- **Redirect URLs:** add both `https://quotes.echobarrier.com/**` and
  `https://<SITE>.netlify.app/**` (the latter for testing before DNS).

Without this, login/onboarding/`/auth/callback` redirects will fail in production.

---

## 3. Subdomain: Cloudflare → Netlify

### 3.1 Netlify side
Site → **Domain management → Add a domain** → `quotes.echobarrier.com` → Add.
Netlify shows the target to point at (a `<SITE>.netlify.app` CNAME).

### 3.2 Cloudflare side (`echobarrier.com` zone)
**DNS → Records.** There's an existing **broken `quotes` record (points at GitHub
Pages)** — edit or delete it, then ensure:
- **Type:** `CNAME` · **Name:** `quotes` · **Target:** `<SITE>.netlify.app`
- **Proxy status:** **DNS only — GREY cloud** ⚠️ (NOT orange/proxied — Cloudflare's
  proxy in front of Netlify breaks Netlify's auto-SSL and can cause redirect loops)
- **TTL:** Auto → Save.

### 3.3 SSL
Back in Netlify Domain management, once DNS resolves it auto-provisions a Let's
Encrypt cert (a few minutes). Optionally set `quotes.echobarrier.com` as the
**primary domain** and enable **Force HTTPS**.

---

## 4. Post-deploy verification
1. Open `https://quotes.echobarrier.com` → redirects to `/login` over HTTPS.
2. Log in (admin) → dashboard shows all modules; a scoped user (Jillian) sees only Quotes.
3. Quotes: requests queue loads (HubSpot), the quote builder shows the
   probability-of-close field. Transport: Cargo Partner lookup works. BOM: shows
   pricing (mfg keys). MRP: traffic-light board renders.
4. CI: pushes to `main` run the GitHub Actions CI. The optional migration-drift
   guard needs repo secrets `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`
   (skips cleanly if absent).

---

## 5. Security pre-flight (before real users beyond testing)
From the pre-go-live review:
- **Rotate the `service_role` key** (it was public in the old sales-hub repo; it
  bypasses all RLS). Deferred by decision — set a hard deadline; until then keep it
  Netlify-secret only + restrict Supabase network access.
- **Close the legacy anon exposures** (deal_tombstones / product_code_master /
  eb_operations) — shared-DB RLS fixes, do with a dependency check.
- Confirm the repo stayed **private** and no `.env*` is tracked (`git ls-files | grep env`
  should show only `.env.local.example`).
