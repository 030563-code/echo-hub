-- Teach save_customer_invoice about the two new optional delivery lines.
--
-- Patched from the function's own definition rather than retyped: the body is
-- ~130 lines and a transcription slip would break saving for every invoice.
-- The regexp anchors on the delivery_zip assignment, which appears exactly once
-- in the UPDATE, and the DO block raises if it does not match so a silent no-op
-- is impossible. Re-running is safe: it returns early once patched.
--
-- Neither column touches tax. They are absent from linesHash by design, so
-- p_new_hash is unaffected and editing either can never invalidate a
-- calculation.
do $do$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_customer_invoice';

  if v_def is null then
    raise exception 'save_customer_invoice not found';
  end if;

  if position('delivery_location' in v_def) > 0 then
    raise notice 'already patched, nothing to do';
    return;
  end if;

  v_new := replace(
    v_def,
    E'      delivery_zip = nullif(btrim(p_header->>''delivery_zip''), ''''),\n',
    E'      delivery_zip = nullif(btrim(p_header->>''delivery_zip''), ''''),\n'
    || E'      delivery_location = nullif(btrim(p_header->>''delivery_location''), ''''),\n'
    || E'      delivery_requested_by = nullif(btrim(p_header->>''delivery_requested_by''), ''''),\n'
  );

  if v_new = v_def then
    raise exception 'delivery_zip assignment not found, refusing to replace the function blind';
  end if;

  execute v_new;
end
$do$;
