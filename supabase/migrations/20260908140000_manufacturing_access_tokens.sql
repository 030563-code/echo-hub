-- How Bamida reach one purchase order, and nothing else.
--
-- Bamida have no Hub login and must never see costs. Giving them accounts would
-- mean deciding what a factory may see across the whole application; a signed
-- link scoped to a single purchase order decides it once, here.
--
-- The raw token is in the email and nowhere else. Only its sha256 is stored,
-- the same shape as a password reset, so a copy of this table is not a set of
-- working links.
--
-- THE TOKEN IS REUSABLE, NOT SINGLE USE. Bamida come back to it: once to enter
-- their estimated dates, and again days or weeks later to say the order is
-- finished. A single-use token would lock them out after the first visit and
-- put Juraj straight back in the middle, which is the whole thing being
-- removed. So last_used_at is a record and never a gate. expires_at and
-- revoked_at are the gates.

create table if not exists public.manufacturing_access_tokens (
  id           uuid        primary key default gen_random_uuid(),
  -- sha256 of the raw token, hex. Unique so a lookup is one index hit.
  token_hash   text        not null unique,
  po_id        uuid        not null references public.purchase_orders (id) on delete cascade,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_by   uuid        references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint manufacturing_access_tokens_hash_len check (length(token_hash) = 64)
);

create index if not exists manufacturing_access_tokens_po_idx
  on public.manufacturing_access_tokens (po_id);

comment on table public.manufacturing_access_tokens is
  'One reusable signed link per manufacturing purchase order, for a supplier with no Hub account. Raw token lives only in the email; this holds its sha256.';

-- Read and written by the app with the service-role client only. RLS on and
-- every grant revoked: this project grants `authenticated` TRUNCATE on every
-- new table in public by default, and RLS does not restrain TRUNCATE.
alter table public.manufacturing_access_tokens enable row level security;
revoke all on public.manufacturing_access_tokens from public, anon, authenticated;
