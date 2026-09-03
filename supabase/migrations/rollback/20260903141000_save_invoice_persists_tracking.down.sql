-- Reverse the tracking insert in save_customer_invoice, by the same
-- read-modify-write against the LIVE definition. Never restore this function
-- from a file: it has drifted from the repo before.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'save_customer_invoice';
  if v_def is null then raise exception 'save_customer_invoice not found'; end if;

  v_new := replace(v_def, 'is_shipping, ship_from_depot, ship_from_locked, tracking', 'is_shipping, ship_from_depot, ship_from_locked');
  v_new := replace(
    v_new,
    chr(10) || '    -- Xero tracking, max 2 per line, guarded by a CHECK on the column.' ||
    chr(10) || '    coalesce(l->''tracking'', ''[]''::jsonb),',
    ''
  );
  if v_new = v_def then raise notice 'nothing to revert'; return; end if;
  execute v_new;
end $$;
