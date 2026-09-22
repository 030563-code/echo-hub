-- Undo 20260922110000_stock_on_hand_floor.sql.
--
-- Drops the two CHECK constraints and restores the four writers to what they
-- were: the two Hub functions from the migrations that last defined them, the
-- two database-only functions from their live text on 22 Sep 2026.
--
-- THE FLOOR ADJUSTMENTS ARE KEPT. They are ledger movements that explain a
-- balance change; deleting them would leave the balance table saying something
-- no movement accounts for, which is the fault the ledger exists to prevent.

begin;

alter table public.warehouse_stock_levels drop constraint if exists warehouse_stock_levels_on_hand_not_negative;
alter table public.material_stock_levels drop constraint if exists material_stock_levels_quantity_not_negative;

create or replace function public.hub_apply_stock_movements(p_rows jsonb, p_uid uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r          jsonb;
  v_kind     text;
  v_item     text;
  v_wh       text;
  v_sku      text;
  v_qty      numeric;
  v_ref_type text;
  v_ref_id   text;
  v_est      boolean;
  v_note     text;
  v_bal      numeric;
  v_id       uuid;
  v_applied  integer := 0;
  v_skipped  integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'hub_apply_stock_movements: p_rows must be a json array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_item     := r->>'item_kind';
    v_wh       := r->>'warehouse_code';
    v_sku      := r->>'sku';
    v_kind     := r->>'kind';
    v_qty      := (r->>'quantity')::numeric;
    v_ref_type := r->>'ref_type';
    v_ref_id   := r->>'ref_id';
    v_est      := coalesce((r->>'estimated')::boolean, false);
    v_note     := r->>'note';

    if v_item not in ('finished', 'material') then
      raise exception 'hub_apply_stock_movements: bad item_kind %', v_item;
    end if;
    if v_wh is null or v_sku is null or v_kind is null or v_ref_type is null or v_ref_id is null then
      raise exception 'hub_apply_stock_movements: warehouse_code, sku, kind, ref_type and ref_id are all required';
    end if;
    if v_qty is null or v_qty = 0 then
      raise exception 'hub_apply_stock_movements: quantity must be a non-zero number (% % %)', v_wh, v_sku, v_kind;
    end if;

    -- Make sure the balance row exists, then lock it for the read-add-write.
    if v_item = 'finished' then
      insert into public.warehouse_stock_levels (warehouse_code, sku, quantity_on_hand, updated_at)
      values (v_wh, v_sku, 0, now())
      on conflict (warehouse_code, sku) do nothing;
      select quantity_on_hand into v_bal
        from public.warehouse_stock_levels
       where warehouse_code = v_wh and sku = v_sku
         for update;
    else
      insert into public.material_stock_levels (warehouse_code, component_code, quantity, updated_at)
      values (v_wh, v_sku, 0, now())
      on conflict (warehouse_code, component_code) do nothing;
      select quantity into v_bal
        from public.material_stock_levels
       where warehouse_code = v_wh and component_code = v_sku
         for update;
    end if;

    -- The movement. A duplicate (same kind, cause, place, item) conflicts on
    -- stock_movements_once and returns no id: skipped, balance untouched.
    insert into public.stock_movements
      (item_kind, warehouse_code, sku, kind, quantity, balance_after,
       ref_type, ref_id, estimated, note, created_by_uid)
    values
      (v_item, v_wh, v_sku, v_kind, v_qty, v_bal + v_qty,
       v_ref_type, v_ref_id, v_est, v_note, p_uid)
    on conflict (kind, ref_type, ref_id, warehouse_code, sku) do nothing
    returning id into v_id;

    if v_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_item = 'finished' then
      update public.warehouse_stock_levels
         set quantity_on_hand = (v_bal + v_qty)::integer,
             updated_at = now()
       where warehouse_code = v_wh and sku = v_sku;
    else
      update public.material_stock_levels
         set quantity = v_bal + v_qty,
             updated_at = now()
       where warehouse_code = v_wh and component_code = v_sku;
    end if;
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end
$$;

revoke all on function public.hub_apply_stock_movements(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.hub_apply_stock_movements(jsonb, uuid) to service_role;

create or replace function public.hub_sync_xero_stock_to_warehouse()
returns table (depot text, skus int, units numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with latest as (
    select distinct on (s.xero_org, s.xero_item_code)
      s.xero_org, s.xero_item_code, s.qty_on_hand, s.snapshot_date
    from public.xero_stock_snapshot s
    order by s.xero_org, s.xero_item_code, s.snapshot_date desc
  ),
  mapped as (
    select
      m.depot_code,
      m.hubspot_sku_code as sku,
      sum(l.qty_on_hand) as qty,
      string_agg(distinct l.xero_item_code, '+' order by l.xero_item_code) as codes,
      min(m.xero_org) as org
    from latest l
    join public.product_depot_mapping m
      on m.xero_org = l.xero_org
     and lower(trim(m.xero_item_code)) = lower(trim(l.xero_item_code))
     and m.is_active
    -- GROUP is back in, and its level being at or near zero is the normal state of a transit
    -- buffer rather than a missing feed. Raw materials still never arrive here: no mapping row
    -- claims Group's 0002 to 0016 codes (grommets, rivets, webbing, Gortex), so they stay out of
    -- the finished-goods ledger where they belong.
    where l.xero_org in ('UK', 'FRANCE', 'GROUP', 'AUSTRALIA')
    group by m.depot_code, m.hubspot_sku_code
  ),
  written as (
    insert into public.warehouse_stock_levels
      (warehouse_code, sku, quantity_on_hand, source, source_org, source_item_code, source_synced_at, updated_at)
    select w.depot_code, w.sku, w.qty::int, 'xero_sync', w.org, w.codes, now(), now()
    from mapped w
    on conflict (warehouse_code, sku) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          source_org = excluded.source_org,
          source_item_code = excluded.source_item_code,
          source_synced_at = excluded.source_synced_at,
          updated_at = now()
      where public.warehouse_stock_levels.source = 'xero_sync'
    returning warehouse_code, sku, quantity_on_hand
  )
  select written.warehouse_code, count(*)::int, sum(written.quantity_on_hand)::numeric
  from written
  group by written.warehouse_code;
end;
$$;

revoke all on function public.hub_sync_xero_stock_to_warehouse() from public, anon;
grant execute on function public.hub_sync_xero_stock_to_warehouse() to service_role;

CREATE OR REPLACE FUNCTION public.apply_manufacturing_stocktake(p_stocktake_id uuid)
 RETURNS manufacturing_stocktakes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_header public.manufacturing_stocktakes;
    v_line   record;
    v_applied integer := 0;
    v_unmatched integer := 0;
    v_total integer := 0;
    v_qty integer;
    v_wh text;
    v_sku text;
    v_mapping_count integer;
BEGIN
    -- Lock the header
    SELECT * INTO v_header FROM public.manufacturing_stocktakes
        WHERE id = p_stocktake_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Stocktake % not found', p_stocktake_id;
    END IF;
    IF v_header.status = 'applied' THEN
        RAISE EXCEPTION 'Stocktake % already applied at %',
            p_stocktake_id, v_header.applied_at;
    END IF;

    SELECT count(*) INTO v_mapping_count
        FROM public.onix_warehouse_mapping WHERE is_active;

    FOR v_line IN
        SELECT *
          FROM public.manufacturing_stocktake_lines
         WHERE stocktake_id = p_stocktake_id
    LOOP
        v_total := v_total + 1;
        v_wh := NULL;
        v_sku := NULL;

        -- Resolve warehouse: id → code → fallback to EB-SRO if mapping table empty
        IF v_line.onix_stock_id IS NOT NULL THEN
            SELECT eb_warehouse_code INTO v_wh
              FROM public.onix_warehouse_mapping
             WHERE is_active AND onix_stock_id = v_line.onix_stock_id;
        END IF;

        IF v_wh IS NULL AND v_line.onix_stock_code IS NOT NULL THEN
            SELECT eb_warehouse_code INTO v_wh
              FROM public.onix_warehouse_mapping
             WHERE is_active
               AND lower(onix_stock_code) = lower(v_line.onix_stock_code);
        END IF;

        IF v_wh IS NULL AND v_mapping_count = 0 THEN
            -- No warehouse mapping configured at all → assume single SRO warehouse
            v_wh := 'EB-SRO';
        END IF;

        IF v_wh IS NULL THEN
            UPDATE public.manufacturing_stocktake_lines
               SET match_status = 'unmatched_warehouse'
             WHERE id = v_line.id;
            v_unmatched := v_unmatched + 1;
            CONTINUE;
        END IF;

        -- Resolve SKU
        SELECT eb_sku INTO v_sku
          FROM public.onix_sku_mapping
         WHERE onix_ns_number = v_line.onix_ns_number;

        IF v_sku IS NULL THEN
            UPDATE public.manufacturing_stocktake_lines
               SET match_status = 'unmatched_sku',
                   resolved_warehouse_code = v_wh
             WHERE id = v_line.id;
            v_unmatched := v_unmatched + 1;
            CONTINUE;
        END IF;

        -- Prefer Available; fall back to Balance; never write NULL
        v_qty := round(coalesce(v_line.available, v_line.balance, 0))::integer;

        UPDATE public.warehouse_stock_levels
           SET quantity_on_hand = v_qty,
               last_counted_at  = v_header.captured_at,
               updated_at       = now()
         WHERE warehouse_code = v_wh AND sku = v_sku;

        IF NOT FOUND THEN
            INSERT INTO public.warehouse_stock_levels
                (warehouse_code, sku, product_name, quantity_on_hand,
                 last_counted_at, updated_at)
            VALUES (v_wh, v_sku, v_line.onix_product_name, v_qty,
                    v_header.captured_at, now());
        END IF;

        UPDATE public.manufacturing_stocktake_lines
           SET match_status = 'applied',
               resolved_warehouse_code = v_wh,
               resolved_sku = v_sku,
               applied_quantity = v_qty
         WHERE id = v_line.id;
        v_applied := v_applied + 1;
    END LOOP;

    UPDATE public.manufacturing_stocktakes
       SET status        = 'applied',
           applied_at    = now(),
           applied_lines = v_applied,
           unmatched_lines = v_unmatched,
           total_lines   = v_total
     WHERE id = p_stocktake_id
    RETURNING * INTO v_header;

    -- Older applied stocktakes for the same source become superseded
    UPDATE public.manufacturing_stocktakes
       SET status = 'superseded'
     WHERE status = 'applied'
       AND id <> p_stocktake_id
       AND source = v_header.source
       AND captured_at < v_header.captured_at;

    RETURN v_header;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_stock(p_warehouse_code text, p_sku text, p_qty integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE warehouse_stock_levels
  SET quantity_on_hand = quantity_on_hand - p_qty,
      updated_at = now()
  WHERE warehouse_code = p_warehouse_code AND sku = p_sku;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found in warehouse %', p_sku, p_warehouse_code;
  END IF;
END;
$function$;

commit;
