-- Format guards on the invoice's ship-to snapshot.
--
-- Format only, deliberately NOT all-or-nothing: customer_invoices legitimately
-- holds a partial or empty address (the "Missing address" queue state, and a
-- collected invoice that needs no delivery address at all). The all-or-nothing
-- rule belongs on deals_registry, where the rep enters it.
--
-- The state list is byte-identical to US_STATE_CODES in src/lib/us-address.ts
-- (50 states + DC, no territories). Two sources of truth is the accepted cost
-- of the database being a real backstop rather than a mirror of app logic.
--
-- APPLIED LIVE via MCP apply_migration (customer_invoice_address_format) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

alter table public.customer_invoices
  add constraint customer_invoices_delivery_state_ck check (
    delivery_state is null or delivery_state in
      ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY',
       'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
       'OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')
  ),
  add constraint customer_invoices_delivery_zip_ck check (
    delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$'
  ),
  add constraint customer_invoices_delivery_country_ck check (
    delivery_country = 'US'
  );
