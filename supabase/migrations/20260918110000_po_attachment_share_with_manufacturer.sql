-- Jozef Šidík, 18 Sep 2026: the order document carries no previews when the
-- order includes a printed logo. There is no artwork field anywhere in either
-- database, and inventing one would mean a whole asset pipeline. What Juraj and
-- Martin already have is a file on their desk, so let them put it on the
-- purchase order and let the factory download it.
--
-- 🔴 FALSE BY DEFAULT. Everything else in po_attachments is internal: supplier
-- invoices, costed sheets, correspondence. Download already requires cost.view
-- for exactly that reason. A file only reaches the manufacturer when somebody
-- here ticks it, one file at a time.
--
-- No policy change. The factory account holds none of the can_read_po()
-- capabilities and must not: src/lib/factory/orders.ts reads with the service
-- role and scopes the rows itself, so that is where this flag is read too.
alter table public.po_attachments
  add column if not exists share_with_manufacturer boolean not null default false;

comment on column public.po_attachments.share_with_manufacturer is
  'True when somebody internal ticked this file for the manufacturer. False by default: every other attachment is internal (vendor invoices, costed sheets) and download requires cost.view. Read only through src/lib/factory/orders.ts, which scopes to a sent SRO_TO_SUPPLIER order.';

do $$
declare
  n int;
  dflt boolean;
  nullable text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'po_attachments'
     and column_name = 'share_with_manufacturer';
  if n <> 1 then raise exception 'share_with_manufacturer did not land'; end if;

  select is_nullable into nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'po_attachments'
     and column_name = 'share_with_manufacturer';
  if nullable <> 'NO' then raise exception 'share_with_manufacturer must be NOT NULL'; end if;

  -- Nothing existing may become shared by this migration.
  select bool_or(share_with_manufacturer) into dflt from public.po_attachments;
  if coalesce(dflt, false) then raise exception 'an existing attachment came out shared'; end if;
end $$;
