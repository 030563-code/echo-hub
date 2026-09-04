-- Removes the two delivery-line assignments from save_customer_invoice, by the
-- same in-place patch so the rest of the body is never retyped. The columns
-- themselves are dropped by the delivery_address_book rollback.
do $do$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_customer_invoice';

  if v_def is null then
    raise exception 'save_customer_invoice not found';
  end if;

  v_new := replace(v_def,
    E'      delivery_location = nullif(btrim(p_header->>''delivery_location''), ''''),\n', '');
  v_new := replace(v_new,
    E'      delivery_requested_by = nullif(btrim(p_header->>''delivery_requested_by''), ''''),\n', '');

  if v_new = v_def then
    raise notice 'nothing to remove';
    return;
  end if;

  execute v_new;
end
$do$;
