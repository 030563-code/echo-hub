-- Restore the accepted-quote payload join to the deal's depot.
--
-- WARNING: after rolling this back, a fitting-kit component on a US-SBD deal
-- goes to the quote-accepted and quote-accepted-mcs webhooks with a NULL
-- xero_item_code again, because HKNA and BUNNA are mapped only at Baltimore and
-- Hamilton. Roll back 20260904110000 as well, or the split stays on with no
-- codes to go with it.
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

  line_count := COALESCE(
    jsonb_array_length(
      CASE WHEN jsonb_typeof(NEW.line_items_raw) = 'array'
           THEN NEW.line_items_raw ELSE '[]'::jsonb END
    ), 0);

  IF NEW.deal_status IN ('1170409275')
     AND valid_depot
     AND line_count > 0
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

    PERFORM net.http_post(
      url := 'https://medes.app.n8n.cloud/webhook/quote-accepted',
      body := payload,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );

    PERFORM net.http_post(
      url := 'https://medes.app.n8n.cloud/webhook/quote-accepted-mcs',
      body := payload,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );

  END IF;

  RETURN NEW;
END;
$function$;
