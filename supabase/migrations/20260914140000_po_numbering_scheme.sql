-- The purchase order numbering scheme: EBUSA8001, EBCAN8001, EBFRA8001,
-- EBAUS8001, EBGRP8001, and EBSRO8001-1 / EBSRO8001-2.
--
-- Dean, 14 Sep 2026: "The new PO numbering system is as follows: EBUSA8001,
-- EBSRO8001-1 / EBSRO8001-2 / ...-3, EBGRP8001, EBFRA8001, EBAUS8001. These
-- will be set as the purchase order numbers in Xero." The Hub creates the
-- number when an order is raised, and n8n sends that exact number to Xero.
-- Xero no longer numbers these orders and nothing writes a Xero number back
-- over the Hub's.
--
-- NOT APPLIED when this file was written. It is the repo record of what the
-- operator will apply, with MCP apply_migration on korylyniwsqtsvzuzydg.
-- Never db push.
--
-- ORDER OF WORK, and it matters. The n8n workflow Fz7xXgifva5n548u must stop
-- PATCHing po_number back onto the row and must send the Hub's number to Xero
-- as PurchaseOrderNumber BEFORE this migration is applied, or in the same
-- window. Apply this first and leave n8n as it was and every number minted
-- here is overwritten by Xero's own the moment the order reaches n8n: the Hub
-- would show EBUSA8001 for a second and then a Xero number, the series would
-- run on regardless, and the two records would never line up again.
--
-- What changes:
--  - Five sequences, each starting at 8001: po_number_seq_ebusa (US depots),
--    po_number_seq_ebcan (Canada), po_number_seq_ebfra (France),
--    po_number_seq_ebaus (Australia) and po_number_seq_ebgrp (Group orders on
--    s.r.o.). Nobody but the owner can touch them: Supabase's default
--    privileges hand every new sequence to anon and authenticated, so they are
--    revoked explicitly below. Each one is then wound past any number already
--    on an order, so re-applying after the rollback cannot re-issue a number
--    that is already a purchase order number in Xero.
--  - hub_po_prefix_for_depot(depot): the depot code to its series. US-BAL and
--    US-SBD are EBUSA, CA-HAM is EBCAN, EU-FR is EBFRA, AU-SYD is EBAUS. These
--    are the depot codes the Hub carries in from_entity (DEPOT_MAPPING in
--    src/lib/depot-constants.ts, profiles.allowed_depots). EU-SK, GB-BSE and
--    EB-SRO have no series in Dean's scheme, so a depot order from any of them,
--    or from a code nobody has heard of, is refused with a plain message. It
--    never falls back to a series that belongs to another country.
--  - hub_mint_po_number(leg, from, parent): the number for a new order.
--      DEPOT_TO_EB_GROUP  prefix of the depot || next value of its series
--      EB_GROUP_TO_SRO    'EBGRP' || next value (rootless refills included)
--      SRO_TO_SUPPLIER    'EBSRO' || <n> || '-1'  (manufacturing order, Bamida)
--      SRO_TO_CARGO       'EBSRO' || <n> || '-2'  (shipping order, Cargo Partner)
--    <n> is the digits of the parent SRO order's number when that parent is an
--    EB_GROUP_TO_SRO order numbered EBGRP<n>. raise-manufacturing-po.ts and
--    raise-cargo-po.ts both insert these legs with parent_po_id = the SRO order.
--    A parent numbered in the pre-scheme PO- series falls back to
--    generate_po_number() and logs a warning while it does, so a chain that
--    started under the old scheme keeps working and is still visible. A parent
--    numbered anything else is REFUSED rather than quietly given an old-series
--    number: purchase_orders holds no such chain, so that case can only mean
--    something has gone wrong (n8n writing a Xero number over the Hub's, say),
--    and a silent fallback would hide it. Any other leg is refused.
--    The -3 accounting order has no leg of its own, so nothing here mints it.
--  - po_before_insert checks who is asking, then mints. It becomes SECURITY
--    DEFINER with a pinned search_path: the Hub raises depot orders through the
--    session client (create-po.ts, under the "hub: raise PO" policy), and that
--    caller must be able to take a number without being able to call the mint
--    function or the sequences directly. Every other insert path
--    (hub_approve_po_leg, hub_warm_start_po_chain, mrp_draft_po_chain and the
--    service role) already runs as a definer or as the service role.
--  - po_guard_number_update, a new BEFORE UPDATE trigger, refuses a po_number
--    or master_ref change from a signed-in session. Nothing in the Hub renames
--    an order; only n8n and the service role ever wrote to those columns.
--
-- Who may spend a number, and why that is checked in the trigger:
--  - po_before_insert runs BEFORE row level security decides anything, and
--    nextval is not undone by a rollback. So an insert that RLS goes on to
--    refuse has already burned the number it was handed. anon holds INSERT on
--    purchase_orders with no policy behind it, which means anyone with the
--    public anon key could have walked all five series forward through
--    PostgREST and left gaps in numbers that are real Xero purchase orders.
--    anon is now refused in the trigger and its write privileges on the table
--    are revoked as well, since no anon policy exists to use them.
--  - A signed-in caller must hold po.create or po.approve, the same two
--    capabilities the "hub: raise PO" and "hub: approve PO" policies use.
--  - A signed-in caller never chooses its own number either. authenticated
--    holds INSERT and UPDATE on the table including po_number and master_ref,
--    so a po.create holder could otherwise insert a row numbered EBSRO8001-1
--    and block that chain's real manufacturing order for good, the UNIQUE
--    (po_number) constraint refusing the genuine one forever after. Both
--    columns are dropped and re-derived for a session caller.
--  - auth.role() is null on a direct connection (psql, this migration, a
--    definer function called from one), so nothing about the service role, the
--    warm start or the MRP draft changes. They keep passing explicit numbers.
--
-- Uniqueness is already guaranteed and is asserted rather than added:
--  - purchase_orders_po_number_key, UNIQUE (po_number), refuses any repeat.
--  - purchase_orders_parent_leg_uidx, UNIQUE (parent_po_id, leg) where
--    parent_po_id is not null, allows one SRO_TO_SUPPLIER and one SRO_TO_CARGO
--    per SRO order. Both raise actions check for an existing child first, and
--    this index holds under a race. So an EBSRO<n>-1 or -2 can never be minted
--    twice, and there is no -2A / -2B case to number.
--
-- Deliberately untouched: generate_po_number() and po_number_seq keep their
-- grants, because the old-scheme fallback still needs them and the rollback
-- restores a trigger that runs as the caller. mrp_draft_po_chain passes its own
-- numbers and is not affected. hub_warm_start_po_chain with a depot of EB-SRO
-- and no depot_po_number is now refused; pass the number or leave the depot
-- blank for a refill.

-- ---------------------------------------------------------------------------
-- The guarantees this scheme leans on. Stop here if either has gone.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.purchase_orders'::regclass
       and conname = 'purchase_orders_po_number_key'
       and contype = 'u'
  ) then
    raise exception 'purchase_orders_po_number_key (UNIQUE po_number) is missing. Restore it before numbering orders.';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'purchase_orders'
       and indexname = 'purchase_orders_parent_leg_uidx'
  ) then
    raise exception 'purchase_orders_parent_leg_uidx (one child per parent and leg) is missing. Restore it before numbering orders.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The five series.
--
-- Each is wound forward past the highest number its prefix already carries, so
-- the next value is 8001 on a table with none and max + 1 otherwise. The
-- rollback drops these sequences; without this, re-applying would restart every
-- series at 8001 and hand out numbers that are already purchase order numbers
-- in Xero, and UNIQUE (po_number) would refuse the inserts one by one.
--
-- setval carries is_called = false so the stored value IS the next one handed
-- out. The sequences have minvalue 8001, so the 8000-with-is_called-true form
-- is not open to us: setval would refuse 8000 as out of bounds.
-- ---------------------------------------------------------------------------
create sequence public.po_number_seq_ebusa as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebcan as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebfra as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebaus as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebgrp as bigint start with 8001 minvalue 8001 no cycle;

select setval('public.po_number_seq_ebusa', greatest(8001, coalesce((select max(substring(po_number from '^EBUSA([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBUSA[0-9]+$'), 8001)), false);
select setval('public.po_number_seq_ebcan', greatest(8001, coalesce((select max(substring(po_number from '^EBCAN([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBCAN[0-9]+$'), 8001)), false);
select setval('public.po_number_seq_ebfra', greatest(8001, coalesce((select max(substring(po_number from '^EBFRA([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBFRA[0-9]+$'), 8001)), false);
select setval('public.po_number_seq_ebaus', greatest(8001, coalesce((select max(substring(po_number from '^EBAUS([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBAUS[0-9]+$'), 8001)), false);
select setval('public.po_number_seq_ebgrp', greatest(8001, coalesce((select max(substring(po_number from '^EBGRP([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBGRP[0-9]+$'), 8001)), false);

revoke all on sequence
  public.po_number_seq_ebusa,
  public.po_number_seq_ebcan,
  public.po_number_seq_ebfra,
  public.po_number_seq_ebaus,
  public.po_number_seq_ebgrp
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Depot code to series. Mirrored by PO_PREFIX_BY_DEPOT in src/lib/po-number.ts;
-- tests/unit/po-numbering-schema-coherence.test.ts keeps the two identical.
-- ---------------------------------------------------------------------------
create or replace function public.hub_po_prefix_for_depot(p_depot text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
begin
  v_prefix := case p_depot
    when 'US-BAL' then 'EBUSA'
    when 'US-SBD' then 'EBUSA'
    when 'CA-HAM' then 'EBCAN'
    when 'EU-FR' then 'EBFRA'
    when 'AU-SYD' then 'EBAUS'
  end;
  if v_prefix is null then
    raise exception 'Depot % has no purchase order number series. Depot orders can be raised for US-BAL, US-SBD, CA-HAM, EU-FR and AU-SYD.',
      coalesce(nullif(p_depot, ''), '(blank)')
      using hint = 'Add the depot to public.hub_po_prefix_for_depot in a migration before raising orders for it.';
  end if;
  return v_prefix;
end;
$$;

comment on function public.hub_po_prefix_for_depot(text) is
  'The purchase order number series for a depot code (US-BAL -> EBUSA). Raises for a depot with no series. Mirrored by PO_PREFIX_BY_DEPOT in src/lib/po-number.ts.';

revoke all on function public.hub_po_prefix_for_depot(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The mint.
-- ---------------------------------------------------------------------------
create or replace function public.hub_mint_po_number(p_leg text, p_from text, p_parent_po_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix     text;
  v_parent_leg text;
  v_parent_no  text;
  v_digits     text;
begin
  if p_leg = 'DEPOT_TO_EB_GROUP' then
    v_prefix := public.hub_po_prefix_for_depot(p_from);
    if v_prefix = 'EBUSA' then
      return v_prefix || nextval('public.po_number_seq_ebusa');
    elsif v_prefix = 'EBCAN' then
      return v_prefix || nextval('public.po_number_seq_ebcan');
    elsif v_prefix = 'EBFRA' then
      return v_prefix || nextval('public.po_number_seq_ebfra');
    elsif v_prefix = 'EBAUS' then
      return v_prefix || nextval('public.po_number_seq_ebaus');
    end if;
    raise exception 'Series % has no sequence behind it.', v_prefix;
  end if;

  if p_leg = 'EB_GROUP_TO_SRO' then
    return 'EBGRP' || nextval('public.po_number_seq_ebgrp');
  end if;

  if p_leg in ('SRO_TO_SUPPLIER', 'SRO_TO_CARGO') then
    if p_parent_po_id is null then
      raise exception 'A % order takes its number from its SRO order, and this one has no parent_po_id.', p_leg;
    end if;

    select po.leg, po.po_number
      into v_parent_leg, v_parent_no
      from public.purchase_orders po
     where po.id = p_parent_po_id;
    -- No uuid in any message from here down. The caller supplied the id and
    -- learns nothing from having it read back, and a message that told a
    -- stranger whether an id existed would be a free row count of the table.
    if not found then
      raise exception 'The order behind this % order cannot be used to number it.', p_leg;
    end if;

    v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');
    if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then
      return 'EBSRO' || v_digits || case p_leg when 'SRO_TO_SUPPLIER' then '-1' else '-2' end;
    end if;

    -- A chain that started before the new scheme keeps the old series. Say so
    -- in the log: these are numbers that missed the scheme, and after the last
    -- PO- chain is closed a line here means something is wrong rather than old.
    if v_parent_no ~ '^PO-[0-9]+$' then
      raise warning 'Purchase order % is from before the EBGRP scheme, so its % order falls back to the PO- series.',
        v_parent_no, p_leg;
      return public.generate_po_number();
    end if;

    -- Anything else is a bug, not history. purchase_orders holds no chain
    -- outside those two shapes, so landing here means the parent was numbered
    -- by something other than the Hub (n8n writing a Xero number back over it
    -- is the way that happens). Refuse rather than paper over it with a number
    -- from a series nobody is expecting.
    raise exception 'The order behind this % order cannot be used to number it: % is not an EBGRP order, so there is no EBSRO number to derive from it.',
      p_leg, coalesce(nullif(v_parent_no, ''), '(blank)');
  end if;

  raise exception 'No purchase order number series for leg %.', coalesce(nullif(p_leg, ''), '(blank)');
end;
$$;

comment on function public.hub_mint_po_number(text, text, uuid) is
  'Mints the purchase order number for a new order: EBUSA/EBCAN/EBFRA/EBAUS<n> for a depot order, EBGRP<n> for a Group order, EBSRO<n>-1 / -2 for the manufacturing and shipping orders under EBGRP<n>, and the old PO- series under a PO- chain. Any other parent number is refused. Called only by po_before_insert.';

revoke all on function public.hub_mint_po_number(text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The trigger. Same master_ref rules as before; the number source moves, and a
-- signed-in caller is now checked before a number is spent on it.
-- ---------------------------------------------------------------------------
create or replace function public.po_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := auth.role();
begin
  -- 0. Who is asking. This runs before RLS refuses anything and nextval is not
  --    undone by the rollback that follows a refusal, so an unchecked caller
  --    spends real numbers whether or not its row is ever written.
  if v_role = 'anon' then
    raise exception 'Purchase orders cannot be raised without signing in.'
      using errcode = '42501';
  end if;

  if v_role = 'authenticated' then
    if not (public.has_capability('po.create') or public.has_capability('po.approve')) then
      raise exception 'Raising a purchase order needs the po.create or po.approve capability.'
        using errcode = '42501';
    end if;

    -- The session never picks the number. Dropping both columns here sends
    -- them through the rules below instead: a squatted EBSRO8001-1 would block
    -- that chain's real manufacturing order forever, because UNIQUE
    -- (po_number) would then refuse the genuine one. hub_approve_po_leg passes
    -- neither column, so the approve path is unchanged; the warm start and the
    -- MRP draft run as the service role and keep the numbers they pass.
    new.po_number := null;
    new.master_ref := null;
  end if;

  -- 1. Mint a number when none is provided. An explicit number (warm start,
  --    the MRP draft, the old n8n poller, test fixtures) is kept as given.
  if new.po_number is null or new.po_number = '' then
    new.po_number := public.hub_mint_po_number(new.leg, new.from_entity, new.parent_po_id);
  end if;

  -- 2. A root order starts its own chain: master_ref = 'MR-' || po_number.
  if new.parent_po_id is null then
    if new.master_ref is null or new.master_ref = '' then
      new.master_ref := 'MR-' || new.po_number;
    end if;
  else
    -- 3. A child inherits its parent's master_ref.
    if new.master_ref is null or new.master_ref = '' then
      select master_ref into new.master_ref
        from public.purchase_orders
       where id = new.parent_po_id;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Renaming an order is not a thing the Hub does.
--
-- authenticated holds UPDATE on purchase_orders, and the "hub: approve PO"
-- policy does not pin po_number or master_ref, so an approver could otherwise
-- rename an order onto a number reserved for another chain and take it out of
-- service. Nothing in the Hub writes either column on an update. anon is not
-- named here because its UPDATE privilege is revoked below.
-- ---------------------------------------------------------------------------
create or replace function public.po_guard_number_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated'
     and (new.po_number is distinct from old.po_number
          or new.master_ref is distinct from old.master_ref) then
    raise exception 'A purchase order number cannot be changed once the order exists.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.po_guard_number_update() is
  'Refuses a po_number or master_ref change from a signed-in session. The service role and the definer paths are unaffected.';

drop trigger if exists trg_po_number_guard on public.purchase_orders;
create trigger trg_po_number_guard
  before update on public.purchase_orders
  for each row execute function public.po_guard_number_update();

-- No anon policy has ever existed on purchase_orders, so these privileges were
-- only ever a way to reach the BEFORE INSERT trigger and spend numbers.
revoke insert, update, delete, truncate on public.purchase_orders from anon;
