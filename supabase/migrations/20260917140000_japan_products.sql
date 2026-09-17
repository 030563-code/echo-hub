-- Japan as its own barrier type, the way HERC Black is one.
--
-- Dean, 17 Sep 2026: "We wil lalso need to set up Japan as a separate type of
-- barrier. Especially H10 JAPAN TAKAMIYA ... so it is tracked properly in stock
-- etc?", then confirming Takamiya H10 Japan IS the existing EBH10JAPSK, that it
-- should be done "the same way we did Herc Black", and that EB-SRO holds it.
--
-- Itochu needs no product of its own. Verified: every Itochu deal carries zero
-- line items, so there is no HubSpot SKU, and H9JAPBI ("H9 Japan Blue Itochu")
-- sits in item_catalog, which is Bamida's EUR MANUFACTURING catalogue and not a
-- Xero item master. Not one of the 22 EB-SRO xero_item_codes joins to it.
-- Itochu uses EBH9JAPSK, the H9 Japan that already existed.
--
-- Why po_product_catalog is the change that matters: product_depot_mapping
-- already carried both Japan SKUs and mrp_bom_map already carried their full
-- six-component bills, but this table was empty of Japan. It maps an order line
-- to a bom_model_code (src/lib/bom.ts), so without a row here a Japan purchase
-- order could not explode its bill of materials, NEITHER the -1 specification
-- NOR the -3 priced order could be produced, and Japan could not be picked on
-- the raise-PO form at all.
--
-- The model codes H10Japan and H9Japan already exist in the mfg project, costed
-- at +EUR 2.00 manufacturing and +EUR 1.40 printing over the base models, and
-- the spellings match scripts/seed-bom-map.ts SK_SKU_TO_MODEL.
--
-- region is 'SRO' rather than the 'NA' default: the first non-North-America
-- rows in this table. Nothing reads the column, so it is descriptive only.
insert into public.po_product_catalog (sku, product_name, product_family, region, active, bom_model_code, internal_sku)
values
  ('EBH10JAPSK', 'Echo Barrier H10 Japan', 'H10', 'SRO', true, 'H10Japan', 'EBH10JAP'),
  ('EBH9JAPSK',  'Echo Barrier H9 Japan',  'H9',  'SRO', true, 'H9Japan',  'EBH9JAP')
on conflict (sku) do update set
  product_name   = excluded.product_name,
  product_family = excluded.product_family,
  region         = excluded.region,
  bom_model_code = excluded.bom_model_code,
  internal_sku   = excluded.internal_sku,
  active         = true;

-- The cross-organisation code map. product_name matches the strings already in
-- src/app/(dashboard)/transport/actions.ts SKU_NAMES, so the transport board and
-- the catalogue cannot disagree.
insert into public.product_code_master (product_name, internal_sku, product_family, is_active)
select v.product_name, v.internal_sku, v.product_family, true
from (values
  ('Echo Barrier H10 Japan', 'EBH10JAP', 'H10'),
  ('Echo Barrier H9 Japan',  'EBH9JAP',  'H9')
) as v(product_name, internal_sku, product_family)
where not exists (
  select 1 from public.product_code_master p where p.internal_sku = v.internal_sku
);

-- The Xero item codes. Dean, 17 Sep 2026: "lets make a xero item code up for now
-- using the same convention as the US ones then we will add the convention we
-- made here to Xero SRO later."
--
-- These are MINTED, not looked up. Both Xero organisations were read live (HTTP
-- 200 on each) and neither holds a Japan item. Echo Barrier s.r.o's Xero has
-- only eight items and is a cost-coding list, not a product catalogue (Cost
-- Mesh, Cost Trans, DELINFO, H9, OB, OPEN, Pack, Tran). Group has 87 items and
-- its only Japan-ish one is 'D11 (JAP)' "D11 Takamiya", quantity 0, following no
-- convention. So both codes below still have to be CREATED in Xero.
--
-- code_grp is not a guess: Group's Xero really does contain 01-EBH8, 01-EBH9,
-- 01-EBH9X, 01-EBH10, 01-EBH10FR and 01-EBH10HERC, verified live, so Japan slots
-- straight into that series.
--
-- code_sro follows the US convention, which is product code plus depot suffix
-- (H10BALT, H9SB, H10HAM, H10HERCHAM). With SK as the s.r.o. suffix that gives
-- H10JAPSK and H9JAPSK, which is also exactly what
-- product_depot_mapping.xero_item_code already holds for these two SKUs, so the
-- catalogue and the depot mapping now name the same item.
--
-- 🔴 This deliberately does NOT match the older code_sro values in this column
-- (SK-EBH10, SK-EBH9, SK-EBH10Herc). Those use an SK- PREFIX, they disagree with
-- product_depot_mapping's suffix style for the same products, and none of them
-- exists in the s.r.o. Xero org either. The suffix style is what is carried
-- forward. The older rows are left alone rather than rewritten, because changing
-- a code something else may key on is not a silent change to make.
update public.product_code_master
set code_grp = '01-EBH10JAP', code_sro = 'H10JAPSK', updated_at = now()
where internal_sku = 'EBH10JAP';

update public.product_code_master
set code_grp = '01-EBH9JAP', code_sro = 'H9JAPSK', updated_at = now()
where internal_sku = 'EBH9JAP';
