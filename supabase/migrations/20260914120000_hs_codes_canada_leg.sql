-- HS codes on every commercial invoice, and a third leg: Group to Canada.
--
-- Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro
-- to group and group to depots". The invoice already prints an HS code column
-- and generation already fills it from product_hs_codes by sku and leg, but the
-- table is empty, nothing checks what goes into it, and the Hub refuses nothing
-- when a line has no code. The app now refuses to issue an invoice with a blank
-- HS code on any line, and /invoices/hs-codes is where the codes are entered.
-- This migration is the database half of that.
--
-- What changes:
--  - entities: EB-CANADA, Echo Barrier Canada, Inc, invoicing in CAD. The
--    registered address and tax ids are not known yet, so they are placeholders
--    to confirm, the same way the other entities started. No Xero tenant id:
--    none of the existing entity rows carries one.
--  - intercompany_prices: a GROUP_TO_CANADA row for every GROUP_TO_USA row,
--    with the same EUR base. Like the USA leg these are COST-LEVEL PLACEHOLDERS
--    pending Dave and Juraj; the Canada invoice converts the EUR base to CAD at
--    the EUR_CAD rate from fx_weekly, snapshotted on the invoice.
--  - invoice_composition_rules: each rule scoped to GROUP_TO_USA is copied to
--    GROUP_TO_CANADA with the same rule, and a note saying it mirrors the USA
--    rule and needs confirming.
--  - product_hs_codes: a CHECK on leg (the three invoice legs), and a CHECK on
--    hs_code: digits, dots and single spaces only, starting and ending with a
--    digit, 6 to 10 digits in all. 3926.90, 3926 90 97 and 3926.90.9985 pass.
--    src/lib/hs-codes.ts isValidHsCode applies the same rule in the app. The
--    table held no rows when this was written, so neither CHECK can fail on
--    existing data.
--  - product_hs_codes.leg loses its '*' default, because '*' no longer passes
--    the leg CHECK. Every write names its leg.
--
-- No grants change. product_hs_codes still has no write policy: the HS codes
-- screen writes through the service-role client after checking invoice.create.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

insert into public.entities (code, legal_name, address_lines, vat_tax_id, eori, default_currency)
values ('EB-CANADA', 'Echo Barrier Canada, Inc', array['Confirm registered address'], null, null, 'CAD')
on conflict (code) do nothing;

-- Cost-level placeholders pending Dave and Juraj, exactly like the USA leg.
insert into public.intercompany_prices (sku, leg, unit_value, currency, active)
select sku, 'GROUP_TO_CANADA', unit_value, currency, active
from public.intercompany_prices
where leg = 'GROUP_TO_USA'
on conflict (sku, leg) do nothing;

insert into public.invoice_composition_rules (active, country, leg, rule_type, source_sku, config, note, priority)
select r.active, r.country, 'GROUP_TO_CANADA', r.rule_type, r.source_sku, r.config,
       'Mirrors the Group to USA rule for Group to Canada. CONFIRM it applies to Canada.',
       r.priority
from public.invoice_composition_rules r
where r.leg = 'GROUP_TO_USA'
  and not exists (
    select 1 from public.invoice_composition_rules c
    where c.leg = 'GROUP_TO_CANADA'
      and c.rule_type = r.rule_type
      and c.source_sku = r.source_sku
      and c.country is not distinct from r.country
  );

alter table public.product_hs_codes alter column leg drop default;

alter table public.product_hs_codes
  add constraint product_hs_codes_leg_check
  check (leg in ('SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'));

alter table public.product_hs_codes
  add constraint product_hs_codes_hs_code_format
  check (
    hs_code is null
    or (
      hs_code ~ '^[0-9]+([. ][0-9]+)*$'
      and length(regexp_replace(hs_code, '[^0-9]', '', 'g')) between 6 and 10
    )
  );
