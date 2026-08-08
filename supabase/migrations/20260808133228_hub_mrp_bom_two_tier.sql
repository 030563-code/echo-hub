-- The manufacturing BOM, recovered from five Bamida delivery notes (dodacie
-- listy) covering H9, H8, H10, HT 3,5 and Noise Defender, Apr-Jun 2026.
--
-- Two things make this a new pair of tables rather than more columns on
-- mrp_bom_map:
--
-- 1. mrp_bom_map holds a DIFFERENT bill of materials. Its 194 rows are the
--    components ECHO BARRIER supplies to Bamida (PC350FR membrane, ACI acoustic
--    infill, Datatag, Group slitting fee). None appear on any delivery note and
--    PC350 does not exist in the Bamida stock feed, so the two BOMs are
--    disjoint. Merging them would imply a parts list no document supports.
--
-- 2. Consumption is TWO-TIER and mrp_bom_map.qty_per cannot express it.
--    Materials scale either per finished unit or PER PALLET, and the per-pallet
--    set is remarkably stable: 16 wood screws, 6 texa screws, 10 washers,
--    20 m2 kasir, 50 m bag thread, 1 packing bag, 1 metal securing — identical
--    across all five products. Pallet size is 70 units for the 1335 mm panels
--    and 30 for the 3650 mm ones, confirmed by 'Vak na balenie' reading exactly
--    1 per pallet on every note. Requirement is therefore a STEP function:
--    qty_per_unit * Q + qty_per_pallet * ceil(Q / pallet_size). Dividing a
--    delivery note by its batch size — the obvious move — is wrong for a third
--    of the lines and only coincidentally right at that batch size.
--
-- Applied live as version 20260808133228. This file is the record; the repo
-- migration directory is never executed (see project convention).

create table if not exists public.mrp_bom_product (
  fg_code      text primary key,
  fg_label     text not null,
  pallet_size  integer check (pallet_size is null or pallet_size > 0),
  source_doc   text,
  source_date  date,
  source_batch integer,
  source_po    text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.mrp_bom_component (
  id             uuid primary key default gen_random_uuid(),
  fg_code        text not null references public.mrp_bom_product(fg_code) on delete cascade,
  line_no        integer,
  component_code text not null,
  component_desc text not null,
  qty            numeric not null check (qty >= 0),
  unit           text not null,
  basis          text not null check (basis in ('per_unit', 'per_pallet')),
  line_type      text not null check (line_type in ('material', 'operation', 'intermediate')),
  is_gating      boolean not null default true,
  verified       boolean not null default false,
  source_doc     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One row per (product, component, basis). A component may legitimately appear
-- under BOTH bases for the same product — HT 3,5 uses black thread 3097 as its
-- main sewing thread (20 m/unit) AND as bag thread (50 m/pallet), printed as two
-- separate lines. Collapsing those would lose the step behaviour.
create unique index if not exists mrp_bom_component_fg_code_basis_key
  on public.mrp_bom_component (fg_code, component_code, basis);

create index if not exists mrp_bom_component_code_idx
  on public.mrp_bom_component (component_code);

-- Which Hub SKU is built from which Bamida finished good. Deliberately separate
-- from the component rows because the two carry very different evidential
-- weight: a delivery note is primary evidence of what was consumed, but nothing
-- on it states which regional Hub SKU the batch became. That inference stays
-- unconfirmed until a human says otherwise, and the engine treats it as such.
create table if not exists public.mrp_bom_sku_map (
  hub_sku      text primary key,
  fg_code      text not null references public.mrp_bom_product(fg_code),
  confirmed    boolean not null default false,
  confirmed_by text,
  confirmed_at timestamptz,
  rationale    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.mrp_bom_product   enable row level security;
alter table public.mrp_bom_component enable row level security;
alter table public.mrp_bom_sku_map   enable row level security;

create policy "hub: read mrp_bom_product"
  on public.mrp_bom_product for select to authenticated using (true);
create policy "hub: read mrp_bom_component"
  on public.mrp_bom_component for select to authenticated using (true);
create policy "hub: read mrp_bom_sku_map"
  on public.mrp_bom_sku_map for select to authenticated using (true);

-- House pattern (see hub_mrp_grant_hardening): RLS does NOT cover TRUNCATE, so
-- privileges must be revoked explicitly, not just policied.
revoke all on public.mrp_bom_product   from anon, authenticated;
revoke all on public.mrp_bom_component from anon, authenticated;
revoke all on public.mrp_bom_sku_map   from anon, authenticated;
grant select on public.mrp_bom_product   to authenticated;
grant select on public.mrp_bom_component to authenticated;
grant select on public.mrp_bom_sku_map   to authenticated;

comment on table public.mrp_bom_product is
  'Bamida finished goods, one row per "Vyroba Echo Barrier ..." line found on a delivery note. fg_code is the ONIX code; pallet_size is units per pallet, which sets the step size for per_pallet components.';

comment on column public.mrp_bom_product.pallet_size is
  'Units per pallet: 70 for 1335x2050 panels, 30 for 3650x2050. Derived from "Vak na balenie" (packing bag) reading exactly 1 per pallet on all five delivery notes, and cross-checked against six other per-pallet consumables. Null means unknown — the engine must then treat per_pallet rows as non-gating rather than guess.';

comment on table public.mrp_bom_component is
  'Manufacturing BOM lines as printed on Bamida delivery notes. component_code joins bamida_material_stock.ns_number for line_type=material. Quantities are per ONE basis unit, already divided out of the batch.';

comment on column public.mrp_bom_component.basis is
  'per_unit scales with quantity built; per_pallet scales with ceil(qty / pallet_size). Requirement = per_unit*Q + per_pallet*ceil(Q/pallet). Never sum the two — a 71-unit order of a 70/pallet product consumes TWO pallets of consumables.';

comment on column public.mrp_bom_component.line_type is
  'material = consumes stock, gates buildability. operation = labour/machine minutes, feeds the capacity model, never gates on stock (note 000582 SPIDER XYZ at 30 min/unit is shared by H8, HT 3,5 and Noise Defender and is the large-panel bottleneck; H9 does not use it). intermediate = produced in-house from other lines — code 311 is printed Mehler, the output of the UV print operation consuming 5097 plus ink, so gating on it would double-count the skin.';

comment on column public.mrp_bom_component.is_gating is
  'Whether this component bounds max buildable. False for the nine codes Bamida does not expose on our API account (ink 2919, print 311, ratchets 662/1838, packaging 30040/30045, fasteners 371/376/378) — real consumption, but invisible to us, and gating on them would emit a permanent unresolvable warning every run. OPEN QUESTION for DDS&OP #1: several gating rows are packaging consumables (kasir 4898, texa 361, metal securing 1781) which arguably delay shipping rather than stop manufacturing. 1781 currently binds H9 at 280 units on 4 pieces of stock while the real constraint is fabric.';

comment on column public.mrp_bom_component.verified is
  'True where the row is a direct transcription of a delivery note, double-keyed: transcribed once, then re-transcribed blind by an independent pass and diffed (129 of 130 line-entries agreed exactly).';

comment on table public.mrp_bom_sku_map is
  'Hub SKU to Bamida finished good. confirmed=false means INFERRED from product naming and product_code_master, never stated by a document — the engine may report a provisional max_buildable from it but must NOT let it set blocked_by_materials, because blocking a manufacturing decision on an unconfirmed parts list is the dangerous direction of error.';

comment on table public.mrp_bom_map is
  'The OTHER bill of materials: components Echo Barrier supplies to Bamida (PC350FR membrane, ACI acoustic infill, Datatag, Group slitting fee). Disjoint from mrp_bom_component — none appear on a Bamida delivery note and PC350 has no card in the Bamida stock feed, consistent with consigned stock invisible to their system. All 194 rows are verified=false with fuzzy name mappings. NOT read by the buffer engine; the manufacturing gate uses mrp_bom_component.';

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po) values
  ('000716', 'Vyroba Echo Barrier H9 (1335 x 2050 mm)', 70, 'DLE26060008', '2026-06-18', 560, 'PO-00001335'),
  ('000717', 'Vyroba Echo Barrier H8 (3650 x 2050 mm)', 30, 'DLE26060006', '2026-06-12', 240, 'PO-00001332'),
  ('000728', 'Vyroba Echo Barrier H10 Navarovacia reflexna paska (1335 x 2050 mm)', 70, 'DLE26040009', '2026-04-27', 280, 'PO-00001322'),
  ('000750', 'Vyroba Echo Barrier HT 3,5 (3650 x 2050mm)', 30, 'DLE26040005', '2026-04-17', 60, 'PO-00001318'),
  ('000760', 'Vyroba Echo Barrier Noise Defender (3650 x 2050 mm)', 30, 'DLE26050002', '2026-05-11', 300, 'PO-00001292')
on conflict (fg_code) do nothing;

insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_doc)
select v.fg_code, v.line_no, v.component_code, v.component_desc, v.qty, v.unit, v.basis, v.line_type, v.is_gating, true, p.source_doc
from (values
  ('000716', 1, '311', 'Uv potlac Echobarrier', 1, 'ks', 'per_unit', 'intermediate', false),
  ('000716', 2, '2919', 'AGFA ANUVIA 5L', 0.008036, 'l', 'per_unit', 'material', false),
  ('000716', 3, '000340', 'UV tlac + manipulacia', 1.66964, 'min', 'per_unit', 'operation', false),
  ('000716', 4, '000457', 'Grafika - subory pre tlac', 0.053571, 'min', 'per_unit', 'operation', false),
  ('000716', 5, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false),
  ('000716', 6, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false),
  ('000716', 8, '5097', 'Mehler 8540 VS 900 FR RAL 6026 zelena matna 267cm', 2.85, 'm2', 'per_unit', 'material', true),
  ('000716', 9, '606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', true),
  ('000716', 10, '7', 'Mosadzne kruzky 25mm - automaticke', 19, 'ks', 'per_unit', 'material', true),
  ('000716', 11, '2204', 'Reflexna paska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', true),
  ('000716', 12, '3076', 'LOHMANN Duplocoll 3702 50mm x 50m', 5, 'm', 'per_unit', 'material', true),
  ('000716', 13, '2189', 'Nctech nitka 20 ORANZOVA 3516', 39, 'm', 'per_unit', 'material', true),
  ('000716', 14, '000326', 'Rezanie reflexnej pasky', 0.25, 'min', 'per_unit', 'operation', false),
  ('000716', 15, '000308', 'Sitie', 10, 'min', 'per_unit', 'operation', false),
  ('000716', 16, '000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', false),
  ('000716', 17, '000328', 'Praca- Vybitie kruzkov', 4, 'min', 'per_unit', 'operation', false),
  ('000716', 18, '662', 'Racna s pasom 50mm + racny pas komplet', 0.017857, 'ks', 'per_unit', 'material', false),
  ('000716', 19, '000664', 'Zvaranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', false),
  ('000716', 20, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000716', 21, '4898', 'TK.PE 753 modry kasir', 20, 'm2', 'per_pallet', 'material', true),
  ('000716', 22, '2192', 'Nctech nitka 34 cierna 4000', 50, 'm', 'per_pallet', 'material', true),
  ('000716', 23, '30045', 'Kovove zaistenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000716', 24, '1781', 'Kovove istenie', 1, 'ks', 'per_pallet', 'material', true),
  ('000716', 25, '371', 'SKR. do dreva zlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false),
  ('000716', 26, '378', 'KAROS. PODLOZKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false),
  ('000716', 27, '361', 'Texa do zeleza 4,8X25', 6, 'ks', 'per_pallet', 'material', true),
  ('000716', 28, '1838', 'Textilne racne', 0.017857, 'ks', 'per_unit', 'material', false),
  ('000717', 1, '311', 'Uv potlac Echobarrier H8', 1, 'ks', 'per_unit', 'intermediate', false),
  ('000717', 2, '2919', 'AGFA ANUVIA 5L', 0.01875, 'l', 'per_unit', 'material', false),
  ('000717', 3, '000340', 'UV tlac + manipulacia', 5.625, 'min', 'per_unit', 'operation', false),
  ('000717', 4, '000457', 'Grafika', 0.125, 'min', 'per_unit', 'operation', false),
  ('000717', 5, '000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000717', 6, '000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000717', 8, '1424', 'Mehler 8509-636 zelena', 9.3, 'm2', 'per_unit', 'material', true),
  ('000717', 9, '606', 'Lemovka Popruh PP 31S900 10/1/40', 12, 'm', 'per_unit', 'material', true),
  ('000717', 10, '7', 'Mosadzne kruzky 25mm - automaticke', 31, 'ks', 'per_unit', 'material', true),
  ('000717', 11, '2204', 'Reflexna paska heat transfer silver PU 25mm', 5.5, 'm', 'per_unit', 'material', true),
  ('000717', 12, '3076', 'LOHMANN Duplocoll 3702', 9, 'm', 'per_unit', 'material', true),
  ('000717', 13, '2189', 'Nctech nitka 20 ORANZOVA', 32, 'm', 'per_unit', 'material', true),
  ('000717', 14, '000326', 'Rezanie reflexnej pasky', 0.25, 'min', 'per_unit', 'operation', false),
  ('000717', 15, '000308', 'Sitie', 15, 'min', 'per_unit', 'operation', false),
  ('000717', 16, '000328', 'Praca- Vybitie kruzkov', 5, 'min', 'per_unit', 'operation', false),
  ('000717', 17, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false),
  ('000717', 18, '000852', 'Zvaranie Echobarrier VF H8', 1, 'ks', 'per_unit', 'operation', false),
  ('000717', 19, '000582', 'Zvaranie vysoko frekvenciou SPIDER XYZ', 30, 'min', 'per_unit', 'operation', false),
  ('000717', 20, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000717', 21, '4898', 'TK.PE 753 modry kasir', 20, 'm2', 'per_pallet', 'material', true),
  ('000717', 22, '2192', 'Nctech nitka 34 cierna', 50, 'm', 'per_pallet', 'material', true),
  ('000717', 23, '30045', 'Kovove zaistenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000717', 24, '1781', 'Kovove istenie', 1, 'ks', 'per_pallet', 'material', true),
  ('000717', 25, '371', 'SKR. do dreva zlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false),
  ('000717', 26, '376', 'KAROS. PODLOZKA ZI 5X20', 10, 'ks', 'per_pallet', 'material', false),
  ('000717', 27, '361', 'Texa do zeleza 4,8X25', 6, 'ks', 'per_pallet', 'material', true),
  ('000728', 1, '311', 'Uv potlac Echobarrier H10', 1, 'ks', 'per_unit', 'intermediate', false),
  ('000728', 2, '2919', 'AGFA ANUVIA 5L', 0.00725, 'l', 'per_unit', 'material', false),
  ('000728', 3, '000340', 'UV tlac + manipulacia', 2.42857, 'min', 'per_unit', 'operation', false),
  ('000728', 4, '000457', 'Grafika', 0.053571, 'min', 'per_unit', 'operation', false),
  ('000728', 5, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false),
  ('000728', 6, '000657', 'EuroLaser- rez', 2, 'min', 'per_unit', 'operation', false),
  ('000728', 8, '5097', 'Mehler 8540 VS 900 FR RAL 6026 zelena matna 267cm', 2.85, 'm2', 'per_unit', 'material', true),
  ('000728', 9, '900', 'Serge Ferrari meshes 362- 50201 zelena', 2.85, 'm2', 'per_unit', 'material', true),
  ('000728', 10, '606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', true),
  ('000728', 11, '7', 'Mosadzne kruzky 25mm - automaticke', 20, 'ks', 'per_unit', 'material', true),
  ('000728', 12, '2204', 'Reflexna paska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', true),
  ('000728', 13, '2189', 'Nctech nitka 20 ORANZOVA', 39, 'm', 'per_unit', 'material', true),
  ('000728', 14, '000326', 'Rezanie reflexnej pasky', 0.25, 'min', 'per_unit', 'operation', false),
  ('000728', 15, '000308', 'Sitie', 10, 'min', 'per_unit', 'operation', false),
  ('000728', 16, '000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', false),
  ('000728', 17, '000328', 'Praca- Vybitie kruzkov', 4, 'min', 'per_unit', 'operation', false),
  ('000728', 18, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false),
  ('000728', 19, '30045', 'Kovove zaistenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000728', 20, '1781', 'Kovove istenie', 2, 'ks', 'per_pallet', 'material', true),
  ('000728', 21, '371', 'SKR. do dreva zlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false),
  ('000728', 22, '378', 'KAROS. PODLOZKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false),
  ('000728', 23, '361', 'Texa do zeleza 4,8X25', 6, 'ks', 'per_pallet', 'material', true),
  ('000728', 24, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000728', 25, '4898', 'TK.PE 753 modry kasir', 20, 'm2', 'per_pallet', 'material', true),
  ('000728', 26, '3097', 'Nctech nitka 20 cierna 3713-4000', 50, 'm', 'per_pallet', 'material', true),
  ('000750', 1, '311', 'Uv potlac Echobarrier HT 3,5', 1, 'ks', 'per_unit', 'intermediate', false),
  ('000750', 2, '2919', 'AGFA ANUVIA 5L', 0.015, 'l', 'per_unit', 'material', false),
  ('000750', 3, '000340', 'UV tlac + manipulacia', 4, 'min', 'per_unit', 'operation', false),
  ('000750', 4, '000457', 'Grafika', 0.333333, 'min', 'per_unit', 'operation', false),
  ('000750', 5, '000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000750', 6, '000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000750', 8, '3601', 'Mehler Plastel TE 8800-606', 9.3, 'm2', 'per_unit', 'material', true),
  ('000750', 9, '7', 'Mosadzne kruzky 25mm - automaticke', 18, 'ks', 'per_unit', 'material', true),
  ('000750', 10, '3097', 'Nctech nitka 20 cierna 3713-4000', 20, 'm', 'per_unit', 'material', true),
  ('000750', 11, '2204', 'Reflexna paska heat transfer silver PU 25mm', 2.55, 'm', 'per_unit', 'material', true),
  ('000750', 12, '3076', 'LOHMANN Duplocoll 3702', 9, 'm', 'per_unit', 'material', true),
  ('000750', 13, '000326', 'Rezanie reflexnej pasky', 0.25, 'min', 'per_unit', 'operation', false),
  ('000750', 14, '000692', 'Zvaranie Leister Sematec', 10, 'min', 'per_unit', 'operation', false),
  ('000750', 15, '000306', 'Nabitie kruzkov', 4, 'min', 'per_unit', 'operation', false),
  ('000750', 16, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false),
  ('000750', 17, '000852', 'Zvaranie Echobarrier VF', 1, 'ks', 'per_unit', 'operation', false),
  ('000750', 18, '000582', 'Zvaranie vysoko frekvenciou SPIDER XYZ', 30, 'min', 'per_unit', 'operation', false),
  ('000750', 19, '30045', 'Kovove zaistenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000750', 20, '1781', 'Kovove istenie', 1, 'ks', 'per_pallet', 'material', true),
  ('000750', 21, '371', 'SKR. do dreva zlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false),
  ('000750', 22, '378', 'KAROS. PODLOZKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false),
  ('000750', 23, '361', 'Texa do zeleza 4,8X25', 6, 'ks', 'per_pallet', 'material', true),
  ('000750', 24, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000750', 25, '4898', 'TK.PE 753 modry kasir', 20, 'm2', 'per_pallet', 'material', true),
  ('000750', 26, '3097', 'Nctech nitka 20 cierna 3713-4000 (bag thread line)', 50, 'm', 'per_pallet', 'material', true),
  ('000760', 1, '311', 'Uv potlac Echobarrier Noise Defender', 1, 'ks', 'per_unit', 'intermediate', false),
  ('000760', 2, '2919', 'AGFA ANUVIA 5L', 0.0005, 'l', 'per_unit', 'material', false),
  ('000760', 3, '000340', 'UV tlac + manipulacia', 8.4, 'min', 'per_unit', 'operation', false),
  ('000760', 4, '000457', 'Grafika', 0.1, 'min', 'per_unit', 'operation', false),
  ('000760', 5, '000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000760', 6, '000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', false),
  ('000760', 8, '4973', 'Mehler 8954 - 729 siva', 11, 'm2', 'per_unit', 'material', true),
  ('000760', 9, '3076', 'LOHMANN Duplocoll 3702', 5, 'm', 'per_unit', 'material', true),
  ('000760', 10, '5', 'Pozinkovane kruzky 25mm automaticke', 19, 'ks', 'per_unit', 'material', true),
  ('000760', 11, '000326', 'Rezanie reflexnej pasky', 0.25, 'min', 'per_unit', 'operation', false),
  ('000760', 12, '000328', 'Praca- Vybitie kruzkov', 4, 'min', 'per_unit', 'operation', false),
  ('000760', 13, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false),
  ('000760', 14, '2205', 'Reflexna paska heat transfer silver PU 50mm', 1, 'm', 'per_unit', 'material', true),
  ('000760', 15, '000852', 'Zvaranie Echobarrier VF Noise Defender', 1, 'ks', 'per_unit', 'operation', false),
  ('000760', 16, '000582', 'Zvaranie vysoko frekvenciou SPIDER XYZ', 30, 'min', 'per_unit', 'operation', false),
  ('000760', 17, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000760', 18, '4898', 'TK.PE 753 modry kasir', 20, 'm2', 'per_pallet', 'material', true),
  ('000760', 19, '30045', 'Kovove zaistenie', 1, 'ks', 'per_pallet', 'material', false),
  ('000760', 20, '1781', 'Kovove istenie', 1, 'ks', 'per_pallet', 'material', true),
  ('000760', 21, '371', 'SKR. do dreva zlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false),
  ('000760', 22, '378', 'KAROS. PODLOZKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false),
  ('000760', 23, '361', 'Texa do zeleza 4,8X25', 6, 'ks', 'per_pallet', 'material', true)
) as v(fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating)
join public.mrp_bom_product p on p.fg_code = v.fg_code
on conflict (fg_code, component_code, basis) do nothing;

-- Provisional only. Nothing on a delivery note names a regional Hub SKU; these
-- are matched via product_code_master product_family and the panel dimensions
-- printed in fg_label. Confirmation is a DDS&OP #1 item.
insert into public.mrp_bom_sku_map (hub_sku, fg_code, confirmed, rationale) values
  ('EBH9NA',  '000716', false, 'product_code_master EBH9 "Echo Barrier H9"; DL panel 1335x2050 matches the standard H9. High confidence, still unconfirmed.'),
  ('EBH8NA',  '000717', false, 'product_code_master EBH8 "Echo Barrier H8"; DL panel 3650x2050. High confidence, still unconfirmed.'),
  ('EBH10NA', '000728', false, 'product_code_master EBH10 "Echo Barrier H10". CAVEAT: the delivery note is the "Navarovacia reflexna paska" variant and carries a Serge Ferrari mesh skin as well as the Mehler skin — it may be a variant rather than the base H10. Confirm before this is allowed to block.')
on conflict (hub_sku) do nothing;
