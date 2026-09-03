-- Teach save_customer_invoice to persist customer_invoice_lines.tracking.
--
-- Patched from the LIVE definition, never from a repo copy. The invoicing
-- functions have drifted: raise_customer_invoice on disk still sets status and
-- rejects 'authorizing', while the live one does neither, so replacing one
-- wholesale from a file would silently revert a fix that is only in production.
-- Reading pg_get_functiondef and rewriting exactly two substrings keeps every
-- other difference intact, and the guard makes a shape change fail loudly
-- instead of half-applying.
--
-- APPLIED LIVE via MCP apply_migration (save_invoice_persists_tracking) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'save_customer_invoice';

  if v_def is null then
    raise exception 'save_customer_invoice not found';
  end if;

  if position('tracking' in v_def) > 0 then
    raise notice 'already persists tracking, nothing to do';
    return;
  end if;

  v_new := replace(
    v_def,
    'is_shipping, ship_from_depot, ship_from_locked' || chr(10) || '  )',
    'is_shipping, ship_from_depot, ship_from_locked, tracking' || chr(10) || '  )'
  );

  v_new := replace(
    v_new,
    'coalesce((l->>''is_shipping'')::boolean, false),',
    'coalesce((l->>''is_shipping'')::boolean, false),' || chr(10) ||
    '    -- Xero tracking, max 2 per line, guarded by a CHECK on the column.' || chr(10) ||
    '    coalesce(l->''tracking'', ''[]''::jsonb),'
  );

  if v_new = v_def then
    raise exception 'neither anchor matched; the function body has changed shape';
  end if;

  execute v_new;
end $$;
