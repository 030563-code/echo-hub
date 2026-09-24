-- Which manufacturing model a product code is built as, and the Hub's own Bamida prices.
--
-- Dean, 24 Sep 2026, after the s.r.o. found prices missing and wrong on the -3 priced orders:
-- "Okay can we fix naming gaps?" and "and also allow them to edit these manully under BOM?"
--
-- WHY A TABLE AND NOT product_code_master.bom_model_code. That column spells a product the way the
-- demand history does (H9X, dB-RT, NoiseDefender), because mrp_demand_engine_feed joins
-- mrp_demand_history.product_model to it (20260917230000). The bill of materials is keyed on the
-- manufacturing sheet's names instead (H9X 2.1W, NDT, NDS200). Four product codes had no bill of
-- materials for that reason, so their orders froze with no manufacturing or printing price and no
-- materials. Renaming the column's values would have taken that demand out of the stock prediction.
--
-- bom_product_model   a product code to the bom_weekly_snapshot model it is costed as. Read before
--                     both product tables, and only by the bill of materials (src/lib/bom.ts).
-- bom_bamida_price    Bamida's manufacturing and printing price per model, set in the Hub. The
--                     weekly sync rewrites bom_weekly_snapshot from Dave's sheet every Monday, so a
--                     price typed there would not survive a week. A null part means the sheet's.
--
-- Prices are never seeded here: this repository is public. Both tables are service role only;
-- the gated actions in src/app/actions/bom write them and audit every change to bom_edit_log.

create table if not exists public.bom_product_model (
  sku text primary key check (sku = btrim(sku) and length(sku) between 1 and 40),
  model_code text not null check (model_code = btrim(model_code) and length(model_code) between 1 and 60),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_label text,
  updated_at timestamptz not null default now()
);

comment on table public.bom_product_model is
  'The manufacturing model (bom_weekly_snapshot.model_code) a product code is costed as, chosen under BOM. Wins over po_product_catalog and product_code_master for the bill of materials only; the demand feed never reads it.';

create table if not exists public.bom_bamida_price (
  model_code text primary key check (model_code = btrim(model_code) and length(model_code) between 1 and 60),
  manufacturing_eur numeric(12, 4) check (manufacturing_eur is null or manufacturing_eur between 0 and 100000),
  printing_eur numeric(12, 4) check (printing_eur is null or printing_eur between 0 and 100000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_label text,
  updated_at timestamptz not null default now(),
  constraint bom_bamida_price_says_something check (manufacturing_eur is not null or printing_eur is not null)
);

comment on table public.bom_bamida_price is
  'Bamida''s manufacturing and printing price per barrier, set in the Hub. Wins over bom_weekly_snapshot.bamida_man_eur / bamida_print_eur, which the weekly sheet sync rewrites. A null part falls back to the sheet.';

-- The four product codes with no bill of materials, and the Herc barrier the demand history spells
-- H10Herc. Each is what the evidence on 24 Sep 2026 supports:
--   EBH9X      H9X 2.1W      the North American EBH9XNA is already costed as H9X 2.1W. The two H9X
--                            rows differ only in the PC350FR roll the fabric is cut from.
--   DBRT       NDT           code_sro SK-NDRT-100, code_uk 01-NDT; operations typed exactly the NDT
--                            manufacturing and printing prices onto the first DBRT order by hand.
--   DBRS, NDS  NDS200        both are code_sro SK-NDRS-200, the Noise Defender RS-200.
--   EBH10HERC  H10HercBlack  the North American EBH10HERCNA is already costed as H10HercBlack.
-- EU3.5 is left alone: whether it is the HT3.5 is an open question for the s.r.o.
insert into public.bom_product_model (sku, model_code, updated_by_label)
values
  ('EBH9X', 'H9X 2.1W', 'Hub migration 20260924180000'),
  ('DBRT', 'NDT', 'Hub migration 20260924180000'),
  ('DBRS', 'NDS200', 'Hub migration 20260924180000'),
  ('NDS', 'NDS200', 'Hub migration 20260924180000'),
  ('EBH10HERC', 'H10HercBlack', 'Hub migration 20260924180000')
on conflict (sku) do nothing;

insert into public.bom_edit_log (model_code, edited_by_label, before, after)
select 'PRODUCT:' || m.sku, m.updated_by_label, jsonb_build_object('model_code', pcm.bom_model_code), jsonb_build_object('model_code', m.model_code)
from public.bom_product_model m
left join public.product_code_master pcm on pcm.internal_sku = m.sku
where m.updated_by_label = 'Hub migration 20260924180000';

alter table public.bom_product_model enable row level security;
alter table public.bom_bamida_price enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bom_product_model', 'bom_bamida_price']
  loop
    execute format('drop policy if exists "Service role full access" on public.%I', t);
    execute format(
      'create policy "Service role full access" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['bom_product_model', 'bom_bamida_price']
  loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t and rowsecurity) then
      raise exception 'row level security is off on %', t;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception 'anon or authenticated still hold grants on %', t;
    end if;
  end loop;
end $$;
