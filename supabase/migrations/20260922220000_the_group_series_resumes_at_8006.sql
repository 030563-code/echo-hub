-- The Group purchase order series resumes at EBGRP8006.
--
-- On 22 Sep 2026 two attempts to raise a Group order were refused by row level
-- security (see 20260922210000). po_before_insert mints the number BEFORE the
-- policy decides and nextval is not undone by a rollback, so both attempts spent
-- a number without leaving a row: po_number_seq_ebgrp reached 8007 while the
-- highest real order was EBGRP8005.
--
-- Dean, 22 Sep 2026: "we make sure it is 8006 thos others can surely be deleted."
-- There is nothing to delete. The refused inserts never became rows; only the
-- counter moved. So the counter is wound back and the series carries on with no
-- gap, which is what a gapless series is for.
--
-- 🔴 WHY THIS IS SAFE HERE AND IS NOT A HABIT. Rewinding a live sequence is
-- normally how a number gets issued twice. It is safe in this one case only
-- because the skipped numbers were never written anywhere: not to a row, not to
-- Xero, not onto a document. The guard below proves that at apply time and
-- refuses rather than guessing. purchase_orders_po_number_key, UNIQUE
-- (po_number), is the backstop if anything is ever missed.
--
-- Never run this pattern against a series whose numbers have left the building.
-- An EBGRP number that reached Xero belongs to a record we do not own.

do $$
declare
  clash int;
  highest int;
  seq_now bigint;
begin
  select count(*) into clash
    from public.purchase_orders
   where po_number in ('EBGRP8006', 'EBGRP8007');

  if clash > 0 then
    raise exception
      '% purchase order(s) already carry EBGRP8006 or EBGRP8007, so the counter must NOT be wound back.',
      clash;
  end if;

  select max((substring(po_number from '^EBGRP([0-9]+)$'))::int) into highest
    from public.purchase_orders
   where po_number ~ '^EBGRP[0-9]+$';

  if highest is null then
    raise exception 'no EBGRP order exists, so there is nothing to resume from';
  end if;

  select last_value into seq_now from public.po_number_seq_ebgrp;

  if seq_now <= highest then
    raise notice 'po_number_seq_ebgrp is already at % against a highest order of %; nothing to do', seq_now, highest;
    return;
  end if;

  raise notice 'winding po_number_seq_ebgrp back from % to %, so the next order is EBGRP%',
    seq_now, highest, highest + 1;

  -- is_called = true, so the next nextval() returns highest + 1.
  perform setval('public.po_number_seq_ebgrp', highest, true);
end $$;

do $$
declare
  seq_now bigint;
  highest int;
begin
  select last_value into seq_now from public.po_number_seq_ebgrp;
  select max((substring(po_number from '^EBGRP([0-9]+)$'))::int) into highest
    from public.purchase_orders where po_number ~ '^EBGRP[0-9]+$';

  if seq_now <> highest then
    raise exception 'po_number_seq_ebgrp is at % but the highest order is EBGRP%; the next number would be wrong',
      seq_now, highest;
  end if;
end $$;
