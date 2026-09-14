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
-- What changes:
--  - Five sequences, each starting at 8001: po_number_seq_ebusa (US depots),
--    po_number_seq_ebcan (Canada), po_number_seq_ebfra (France),
--    po_number_seq_ebaus (Australia) and po_number_seq_ebgrp (Group orders on
--    s.r.o.). Nobody but the owner can touch them: Supabase's default
--    privileges hand every new sequence to anon and authenticated, so they are
--    revoked explicitly below.
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
--    A parent carrying a number from before today (PO-01224, or a Xero number
--    such as EBG26086) falls back to generate_po_number(), so a chain that
--    started under the old scheme keeps working. Any other leg is refused.
--    The -3 accounting order has no leg of its own, so nothing here mints it.
--  - po_before_insert calls hub_mint_po_number when po_number is blank. The
--    master_ref rules are unchanged. It becomes SECURITY DEFINER with a pinned
--    search_path: the Hub raises depot orders through the session client
--    (create-po.ts, under the "hub: raise PO" policy), and that caller must be
--    able to take a number without being able to call the mint function or the
--    sequences directly. Every other insert path (hub_approve_po_leg,
--    hub_warm_start_po_chain, mrp_draft_po_chain and the service role) already
--    runs as a definer or as the service role.
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
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

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
-- ---------------------------------------------------------------------------
create sequence public.po_number_seq_ebusa as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebcan as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebfra as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebaus as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebgrp as bigint start with 8001 minvalue 8001 no cycle;

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
    if not found then
      raise exception 'The SRO order % behind this % order does not exist.', p_parent_po_id, p_leg;
    end if;

    v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');
    if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then
      return 'EBSRO' || v_digits || case p_leg when 'SRO_TO_SUPPLIER' then '-1' else '-2' end;
    end if;

    -- A chain that started before the new scheme keeps the old series.
    return public.generate_po_number();
  end if;

  raise exception 'No purchase order number series for leg %.', coalesce(nullif(p_leg, ''), '(blank)');
end;
$$;

comment on function public.hub_mint_po_number(text, text, uuid) is
  'Mints the purchase order number for a new order: EBUSA/EBCAN/EBFRA/EBAUS<n> for a depot order, EBGRP<n> for a Group order, EBSRO<n>-1 / -2 for the manufacturing and shipping orders under EBGRP<n>, and the old PO- series under an older chain. Called only by po_before_insert.';

revoke all on function public.hub_mint_po_number(text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The trigger. Same master_ref rules as before; only the number source moves.
-- ---------------------------------------------------------------------------
create or replace function public.po_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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
