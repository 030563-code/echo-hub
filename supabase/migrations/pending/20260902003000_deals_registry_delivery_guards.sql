-- NOT APPLIED. Needs Dean's go-ahead.
--
-- Enforce "leave it null rather than filling it in" in the database, not only
-- in TypeScript. A half-written or malformed delivery address is the dangerous
-- case: it looks complete, TaxJar returns HTTP 200, and the tax is confidently
-- wrong for a jurisdiction nobody chose.
--
-- Verified before writing: 0 of 2,062 live rows fail this predicate (all five
-- columns are NULL on every row today), and the all-NULL case passes by
-- construction. Adding a CHECK fires no row triggers, so this is silent with
-- respect to the deals_registry webhooks.
--
-- Blast radius: this permanently changes the failure mode of a live table that
-- n8n writes to on every HubSpot deal change. No current writer touches these
-- columns except the Hub acceptance gate, which always writes all five from a
-- sanitizeUSAddress-validated value. A FUTURE writer that sets a partial
-- address will have its whole row-write rejected rather than half-succeeding.
-- That trade is deliberate: a stopped sync is visible, a half-written address
-- is not.
--
-- NEVER add an UPDATE on deals_registry to this or any migration. The table has
-- an unconditional AFTER trigger that POSTs every touched row to n8n, and a
-- BEFORE trigger that rewrites line_items_raw from depot_code, which can in
-- turn re-fire the accepted-quote pipeline and duplicate Xero quotes.
--
-- Rollback: supabase/migrations/rollback/20260902003000_deals_registry_delivery_guards.down.sql

set local lock_timeout = '3s';

alter table public.deals_registry
  -- All five together or none at all. A four-of-five address is the silent
  -- failure this whole migration exists to prevent.
  add constraint deals_registry_delivery_complete_ck check (
    num_nonnulls(delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country) in (0, 5)
  ),
  -- An empty string is not NULL, so it would otherwise satisfy the rule above
  -- while carrying no address at all.
  add constraint deals_registry_delivery_nonblank_ck check (
    (delivery_street is null or btrim(delivery_street) <> '')
    and (delivery_city is null or btrim(delivery_city) <> '')
  ),
  -- Explicit list, not ^[A-Z]{2}$, which would accept 'XX' and 'ZZ'.
  -- Byte-identical to US_STATE_CODES in src/lib/us-address.ts.
  add constraint deals_registry_delivery_state_ck check (
    delivery_state is null or delivery_state in
      ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY',
       'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
       'OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')
  ),
  add constraint deals_registry_delivery_zip_ck check (
    delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$'
  ),
  add constraint deals_registry_delivery_country_ck check (
    delivery_country is null or delivery_country = 'US'
  );
