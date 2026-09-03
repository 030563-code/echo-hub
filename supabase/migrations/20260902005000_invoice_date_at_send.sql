-- The invoice date is the date the invoice is SENT, not the date the draft was
-- opened (Dean, 2026-09-02). A draft therefore carries no invoice date at all,
-- and the field shows blank until Send to Xero stamps it.
--
-- Three separate places were stamping today's date, so all three have to go or
-- the field silently repopulates: the column default, create_customer_invoice,
-- and save_customer_invoice's coalesce (which made a null unclearable).

alter table public.customer_invoices alter column invoice_date drop default;
alter table public.customer_invoices alter column invoice_date drop not null;

-- Clear the creation-stamped date from everything not yet raised. A raised
-- invoice keeps its date: that one IS the date it went out, and rewriting it
-- would misstate a document that has already been issued.
update public.customer_invoices
   set invoice_date = null
 where invoice_number is null
   and raised_at is null
   and invoice_date is not null;

-- create_customer_invoice: stop defaulting to today.
-- Patched in place from the LIVE definition rather than rewritten from the repo
-- copy, which has drifted before. The guard makes a silent no-op impossible.
do $patch$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_customer_invoice';
  if src is null then
    raise exception 'create_customer_invoice not found';
  end if;
  if position('coalesce((p_header->>''invoice_date'')::date, (now() at time zone ''utc'')::date)' in src) = 0 then
    raise exception 'create_customer_invoice no longer contains the expected invoice_date default';
  end if;
  src := replace(
    src,
    'coalesce((p_header->>''invoice_date'')::date, (now() at time zone ''utc'')::date)',
    '(p_header->>''invoice_date'')::date'
  );
  execute src;
end
$patch$;

-- save_customer_invoice: let an explicit null CLEAR the date.
-- coalesce(new, stored) preserves the stored value when the caller sends null,
-- which is right for a key that is absent but wrong for one the editor sends
-- deliberately empty: Dave could never blank the field. Switch on whether the
-- key is present instead.
do $patch$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_customer_invoice';
  if src is null then
    raise exception 'save_customer_invoice not found';
  end if;
  if position('invoice_date = coalesce((p_header->>''invoice_date'')::date, invoice_date)' in src) = 0 then
    raise exception 'save_customer_invoice no longer contains the expected invoice_date coalesce';
  end if;
  src := replace(
    src,
    'invoice_date = coalesce((p_header->>''invoice_date'')::date, invoice_date)',
    'invoice_date = case when jsonb_exists(p_header, ''invoice_date'') then (p_header->>''invoice_date'')::date else invoice_date end'
  );
  execute src;
end
$patch$;
