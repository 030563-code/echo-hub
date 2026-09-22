-- Undo 20260922220000_the_group_series_resumes_at_8006.
--
-- Puts po_number_seq_ebgrp back where the two refused inserts left it, so the
-- Group series skips 8006 and 8007 again and the next order is EBGRP8008.
--
-- 🔴 This only ever winds the counter FORWARD. If Group orders have been raised
-- since, EBGRP8006 and EBGRP8007 now exist and belong to real documents, so the
-- counter must not drop below them. greatest() is what enforces that: the
-- sequence lands on whichever is higher, the original 8007 or the highest order
-- actually issued. A sequence that moves backwards is how a number gets used
-- twice, and there is no version of undoing this that is worth that.

do $$
declare
  highest int;
  target bigint;
  seq_now bigint;
begin
  select max((substring(po_number from '^EBGRP([0-9]+)$'))::int) into highest
    from public.purchase_orders
   where po_number ~ '^EBGRP[0-9]+$';

  target := greatest(coalesce(highest, 0), 8007);

  select last_value into seq_now from public.po_number_seq_ebgrp;

  if seq_now >= target then
    raise notice 'po_number_seq_ebgrp is already at %, at or past the target of %; nothing to do', seq_now, target;
    return;
  end if;

  raise notice 'winding po_number_seq_ebgrp forward from % to %, so the next order is EBGRP%',
    seq_now, target, target + 1;

  perform setval('public.po_number_seq_ebgrp', target, true);
end $$;

do $$
declare
  seq_now bigint;
  highest int;
begin
  select last_value into seq_now from public.po_number_seq_ebgrp;
  select max((substring(po_number from '^EBGRP([0-9]+)$'))::int) into highest
    from public.purchase_orders where po_number ~ '^EBGRP[0-9]+$';

  if seq_now < coalesce(highest, 0) then
    raise exception 'po_number_seq_ebgrp is at % but EBGRP% already exists; the next number would repeat one',
      seq_now, highest;
  end if;
end $$;
