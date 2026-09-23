-- The colours a fabric can be ordered in, for the -1 manufacturing specification.
--
-- Juraj, 22 Sep 2026: "could we also add colours options to the PC350FR and P200", followed by
-- the list. Both are Goretex fabrics Echo Barrier supplies to Bamida: P200 is the H10 family's
-- face fabric (the standing specification spells it PC200FR), PC350FR is everybody else's. Until
-- now the material line on the specification printed the roll (PC350FR-UV21, 2.7 per barrier) and
-- no colour at all, and the colour travelled by WhatsApp.
--
-- Keyed by FAMILY, not by roll code: the bill of materials says PC350FR-UV21 and PC350FR-UV15 for
-- the same cloth in two widths, and a colour belongs to the cloth. The Hub matches a material to
-- the longest family that starts its code (src/lib/material-colours.ts).
--
-- A picklist in the po_* pattern: read by every internal account, written behind bom.edit like
-- model_spec, because a colour here is a colour the factory may be told to use. Adding a colour is
-- a row, not a deploy. Seeded here, unlike model_spec, because a palette of fabric colours is not
-- the manufacturing specification, and item_catalog already lists these colours in this repo.
create table if not exists public.material_colour_option (
  id uuid primary key default gen_random_uuid(),
  family text not null,
  colour text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (family, colour)
);

comment on table public.material_colour_option is
  'The colours a fabric family (PC350FR, P200) can be ordered in, offered per material line on the -1 manufacturing specification. family = the bill-of-materials code up to the roll width. Juraj''s list of 22 Sep 2026.';

alter table public.material_colour_option enable row level security;

drop policy if exists "hub: read material_colour_option" on public.material_colour_option;
create policy "hub: read material_colour_option"
  on public.material_colour_option for select to authenticated
  using ((select public.is_internal()));

drop policy if exists "hub: write material_colour_option" on public.material_colour_option;
create policy "hub: write material_colour_option"
  on public.material_colour_option for all to authenticated
  using ((select public.has_capability('bom.edit')))
  with check ((select public.has_capability('bom.edit')));

revoke all on public.material_colour_option from public, anon, authenticated;
grant select on public.material_colour_option to authenticated;
grant insert, update on public.material_colour_option to authenticated;
grant all on public.material_colour_option to service_role;

-- Juraj's list, in his order. Re-runnable: an existing colour is left alone.
insert into public.material_colour_option (family, colour, sort_order) values
  ('PC350FR', 'Black', 1),
  ('PC350FR', 'Navy blue', 2),
  ('PC350FR', 'Maroon', 3),
  ('PC350FR', 'Beige', 4),
  ('PC350FR', 'White', 5),
  ('P200', 'Flo orange', 1),
  ('P200', 'Flo yellow', 2),
  ('P200', 'White', 3)
on conflict (family, colour) do nothing;
