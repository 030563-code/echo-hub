-- Group and s.r.o. may raise their own purchase orders.
--
-- 🔴 THE BUG. On 21 Sep 2026 EB-GROUP and EB-SRO were added to the raising
-- parties (src/lib/po-raising.ts) and hub_mint_po_number learned to mint EBGRP
-- and standalone EBSRO numbers for them. The INSERT policy was never widened to
-- match. It still reads `leg = 'DEPOT_TO_EB_GROUP' AND to_entity = 'EB-GROUP'`,
-- so a Group order (EB_GROUP_TO_SRO, on EB-SRO) is refused by row level security
-- and the Hub shows "Failed to raise the purchase order. Please try again."
--
-- Dave hit it on 22 Sep 2026 at 15:05:57 and 15:06:31 UTC: two POSTs, both 403.
-- It has never worked once. Every EB_GROUP_TO_SRO and SRO_TO_SUPPLIER row in the
-- table carries a parent_po_id and a NULL requested_by_uid, which is the
-- signature of the approval chain minting the child leg, not a person raising
-- one. Dean, 22 Sep: "grp doesnt have a depot attached and no master PO is
-- asigned and you didnt account for that."
--
-- 🔴 AND IT BURNS NUMBERS. po_before_insert runs BEFORE row level security
-- decides, and nextval is not undone by a rollback, so each refusal spends an
-- EBGRP number. po_number_seq_ebgrp sits at 8007 against a highest real row of
-- EBGRP8005: Dave's two attempts burned 8006 and 8007. That is a gap in a
-- deliberately gapless series, so it is written down here rather than silently
-- left for somebody to find.
--
-- Dean asked for the gap to be closed, and it was, in the very next migration
-- (20260922220000_the_group_series_resumes_at_8006). That is safe ONLY because
-- the refused inserts left no row and the numbers never reached Xero or a
-- document. Read that migration before ever doing the same to another series.
--
-- WHAT CHANGES. The three clauses that were always shape checks stay exactly as
-- they were (capability, status, source, parent, requested_by_uid). Only the leg
-- test widens, from one leg to three, each pinned to its own counterparty so a
-- leg cannot be pointed at the wrong company:
--
--   DEPOT_TO_EB_GROUP  a depot buys from Group. Unchanged, including the depot
--                      check against the caller's own allowed_depots.
--   EB_GROUP_TO_SRO    Group buys from s.r.o. on its own account.
--   SRO_TO_SUPPLIER    s.r.o. buys from the manufacturer on its own account.
--
-- The depot check does NOT apply to the last two, and that is the point: Group
-- and s.r.o. are companies, not depots, and nobody's allowed_depots contains
-- EB-GROUP or EB-SRO. Which organisation a caller holds is still enforced in
-- createPurchaseOrder via holdsOrganisation(), because Postgres has no
-- organisation helper (only has_capability, is_internal and is_super_admin), and
-- inventing one here would put a second copy of that rule out of step with the
-- first. po.create plus the fixed counterparty is what the database guarantees.
--
-- parent_po_id IS NULL is KEPT for all three. A self-raised order has nothing
-- above it by definition, and the chain's own child legs are written by definer
-- functions and the service role, which this policy never sees.

drop policy if exists "hub: raise PO" on public.purchase_orders;

create policy "hub: raise PO"
  on public.purchase_orders for insert to authenticated
  with check (
    (select public.has_capability('po.create'))
    and status = 'requested'
    and parent_po_id is null
    and source = 'hub'
    and requested_by_uid = (select auth.uid())
    and (
      -- A depot buys from Group, and only a depot the caller actually holds.
      (
        leg = 'DEPOT_TO_EB_GROUP'
        and to_entity = 'EB-GROUP'
        and (
          (select public.is_super_admin())
          or 'ALL' = any (coalesce((select allowed_depots from public.profiles where id = (select auth.uid())), array[]::text[]))
          or from_entity = any (coalesce((select allowed_depots from public.profiles where id = (select auth.uid())), array[]::text[]))
        )
      )
      -- Group buys from s.r.o. There is no depot above it.
      or (leg = 'EB_GROUP_TO_SRO' and from_entity = 'EB-GROUP' and to_entity = 'EB-SRO')
      -- s.r.o. buys from the manufacturer. hub_mint_po_number already gives a
      -- parentless one the standalone EBSRO<n>-1 number.
      or (leg = 'SRO_TO_SUPPLIER' and from_entity = 'EB-SRO' and to_entity = 'SUPPLIER')
    )
  );

do $$
declare
  chk text;
begin
  select pg_get_expr(polwithcheck, polrelid) into chk
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'purchase_orders' and p.polname = 'hub: raise PO';

  if chk is null then
    raise exception 'the raise policy did not survive the replacement';
  end if;
  -- The three legs are all reachable.
  if position('EB_GROUP_TO_SRO' in chk) = 0 then
    raise exception 'Group still cannot raise its own order';
  end if;
  if position('SRO_TO_SUPPLIER' in chk) = 0 then
    raise exception 's.r.o. still cannot raise its own order';
  end if;
  if position('DEPOT_TO_EB_GROUP' in chk) = 0 then
    raise exception 'the depot leg was lost';
  end if;
  -- The guards that were never the problem are all still there.
  if position('requested_by_uid' in chk) = 0
     or position('parent_po_id IS NULL' in chk) = 0
     or position('po.create' in chk) = 0
     or position('allowed_depots' in chk) = 0 then
    raise exception 'a guard was dropped while widening the leg test';
  end if;
end $$;
