-- US accepted-quotes CUTOVER: accepted US quotes (US-BAL / US-SBD) stop
-- becoming draft Xero QUOTES and are invoiced through the Hub instead
-- (customer_invoices -> TaxJar -> n8n -> AUTHORISED Xero invoice). The US
-- branch still notifies Slack via a lightweight n8n webhook, replacing the
-- old Slack approval form. CA-HAM is byte-identical to before.
--
-- ⛔ NOT YET APPLIED — lives in migrations/pending/ so the migrations/ dir
-- stays a mirror of live. Move it into migrations/ WHEN applied.
-- Applying this migration IS the cutover (rollout step 4)
-- and requires: (a) Dean's explicit go-ahead, (b) the n8n webhook
-- /hub-quote-accepted-notify live and published. Apply via MCP
-- apply_migration only; never `db push`. Instant rollback:
-- supabase/migrations/rollback/20260828000000_us_accepted_quotes_cutover.down.sql
-- (the verbatim pre-change live body, captured 2026-08-26 via
-- pg_get_functiondef — the repo/sales-hub copies of this function are STALE;
-- re-capture from live before applying if the trigger has changed since).

CREATE OR REPLACE FUNCTION public.notify_quote_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  payload jsonb;
  enriched_items jsonb;
  company_info RECORD;
  valid_depot boolean;
  clean_company_id bigint;
  clean_depot_code text;
  line_count int;
BEGIN
  clean_depot_code := TRIM(UPPER(NEW.depot_code));

  IF clean_depot_code = 'CA-HAM' THEN
      NEW.currency := 'CAD';
  ELSIF clean_depot_code IN ('US-BAL', 'US-SBD') THEN
      NEW.currency := 'USD';
  END IF;

  BEGIN
    clean_company_id := NULLIF(REGEXP_REPLACE(NEW.hubspot_company_id::text, '[^0-9]', '', 'g'), '')::bigint;
  EXCEPTION WHEN OTHERS THEN
    clean_company_id := NULL;
  END;

  valid_depot := clean_depot_code IN ('US-BAL', 'US-SBD', 'CA-HAM');

  -- NEW: how many line items does this row actually carry?
  line_count := COALESCE(
    jsonb_array_length(
      CASE WHEN jsonb_typeof(NEW.line_items_raw) = 'array'
           THEN NEW.line_items_raw ELSE '[]'::jsonb END
    ), 0);

  IF NEW.deal_status IN ('1170409275')
     AND valid_depot
     AND line_count > 0          -- NEW guard: never send a zero-line document
     AND (
         TG_OP = 'INSERT'
         OR OLD.deal_status IS DISTINCT FROM NEW.deal_status
         OR OLD.line_items_raw IS DISTINCT FROM NEW.line_items_raw
         OR OLD.amount IS DISTINCT FROM NEW.amount
         OR OLD.depot_code IS DISTINCT FROM NEW.depot_code
     ) THEN

    IF clean_company_id IS NULL THEN
      RETURN NEW;
    END IF;

    PERFORM public.ensure_company_xero_codes(clean_company_id, clean_depot_code);

    SELECT * INTO company_info
    FROM public.account_registry
    WHERE hubspot_company_id = clean_company_id;

    -- US CUTOVER (2026-08, Dean + Dave): accepted US quotes are reviewed and
    -- invoiced in the Echo Hub (/invoicing: TaxJar tax calc -> AUTHORISED
    -- Xero invoice via n8n). They no longer become draft Xero quotes, so the
    -- Xero/MCS webhook posts below are skipped for US depots. A Slack
    -- notification replaces the old approval form. ensure_company_xero_codes
    -- above still runs for US (the Hub needs usa_xero_account_code as the
    -- TaxJar customer id and the Xero contact account number).
    IF clean_depot_code IN ('US-BAL', 'US-SBD') THEN
      PERFORM net.http_post(
        url := 'https://medes.app.n8n.cloud/webhook/hub-quote-accepted-notify',
        body := jsonb_build_object(
          'hubspot_deal_id', NEW.hubspot_deal_id,
          'deal_name', NEW.deal_name,
          'company_name', company_info.hubspot_company_name,
          'amount', NEW.amount,
          'depot_code', clean_depot_code,
          'quote_reference', NEW.quote_reference
        ),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
      RETURN NEW;
    END IF;

    SELECT jsonb_agg(
      jsonb_build_object(
        'hubspot_line_item_id', raw_item->>'hs_line_item_id',
        'hubspot_product_id', raw_item->>'hs_product_id',
        'sku', raw_item->>'sku',
        'name', raw_item->>'name',
        'quantity', COALESCE((raw_item->>'quantity')::numeric, 0),
        'unit_price', COALESCE((raw_item->>'unit_price')::numeric, 0),
        'total_amount', COALESCE((raw_item->>'total_amount')::numeric, 0),
        'discount_percentage', COALESCE((raw_item->>'discount_percentage')::numeric, 0),
        'line_item_currency', raw_item->>'currency',
        'xero_item_code', mapping.xero_item_code,
        'xero_item_desc', mapping.xero_item_description,
        'depot_code', clean_depot_code
      )
    )
    INTO enriched_items
    FROM jsonb_array_elements(NEW.line_items_raw) AS raw_item
    LEFT JOIN public.product_depot_mapping mapping
      ON mapping.hubspot_sku_code = (raw_item->>'sku')
      AND mapping.depot_code = clean_depot_code;

    payload := json_build_object(
      'event_type', TG_OP,
      'timestamp', now(),
      'record_id', NEW.id,
      'hubspot_deal_id', NEW.hubspot_deal_id,
      'deal_name', NEW.deal_name,
      'deal_status', NEW.deal_status,
      'quote_reference', NEW.quote_reference,
      'depot_code', clean_depot_code,
      'currency', NEW.currency,
      'total_deal_amount', NEW.amount,
      'hubspot_company_id', clean_company_id,
      'company_name', company_info.hubspot_company_name,
      'usa_xero_account_code', company_info.usa_xero_account_code,
      'can_xero_account_code', company_info.canada_xero_account_code,
      'line_items', COALESCE(enriched_items, '[]'::jsonb)
    )::jsonb;

    -- Xero pipeline (unchanged; still drives Xero contact creation)
    PERFORM net.http_post(
      url := 'https://medes.app.n8n.cloud/webhook/quote-accepted',
      body := payload,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );

    -- MCS pipeline (HubSpot -> MCS Contract)
    PERFORM net.http_post(
      url := 'https://medes.app.n8n.cloud/webhook/quote-accepted-mcs',
      body := payload,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );

  END IF;

  RETURN NEW;
END;
$function$;
