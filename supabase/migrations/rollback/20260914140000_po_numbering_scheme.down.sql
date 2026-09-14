-- Rollback for 20260914140000_po_numbering_scheme.sql.
-- Run it as ONE transaction: through the Supabase SQL editor or MCP execute_sql
-- (one batch), or with psql --single-transaction -f.
--
-- Restores po_before_insert exactly as it was live before the new scheme
-- (SECURITY INVOKER, no pinned search_path, minting from generate_po_number()),
-- then drops the mint function, the depot mapping and the five sequences.
--
-- Numbers already minted stay on their orders. Nothing here rewrites a
-- po_number or a master_ref: EBUSA8001 and friends may already be purchase
-- order numbers in Xero. After the rollback, a new manufacturing or shipping
-- order under an EBGRP order takes an old-scheme PO- number again.
--
-- Also revert the n8n change to workflow Fz7xXgifva5n548u before or with this,
-- or Xero keeps receiving the Hub's number while the Hub mints PO- numbers.

create or replace function public.po_before_insert()
returns trigger
language plpgsql
security invoker
as $function$
BEGIN
    -- 1. Always generate a PO number if one isn't provided
    IF NEW.po_number IS NULL OR NEW.po_number = '' THEN
        NEW.po_number := public.generate_po_number();
    END IF;

    -- 2. If this is a root PO (no parent), generate a new master_ref
    IF NEW.parent_po_id IS NULL THEN
        IF NEW.master_ref IS NULL OR NEW.master_ref = '' THEN
            -- FIX: Instead of currval, base the master_ref on the po_number we just set or received.
            -- If Xero sent 'PO-USA18139', master_ref becomes 'MR-PO-USA18139'
            -- If auto-generated 'PO-00123', master_ref becomes 'MR-PO-00123'
            NEW.master_ref := 'MR-' || NEW.po_number;
        END IF;
    ELSE
        -- 3. Child PO: inherit master_ref from parent
        IF NEW.master_ref IS NULL OR NEW.master_ref = '' THEN
            SELECT master_ref INTO NEW.master_ref
            FROM public.purchase_orders
            WHERE id = NEW.parent_po_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

-- CREATE OR REPLACE already clears the pinned search_path; said again so the
-- restored function carries no configuration whatever the server version.
alter function public.po_before_insert() reset all;

drop function if exists public.hub_mint_po_number(text, text, uuid);
drop function if exists public.hub_po_prefix_for_depot(text);

drop sequence if exists
  public.po_number_seq_ebusa,
  public.po_number_seq_ebcan,
  public.po_number_seq_ebfra,
  public.po_number_seq_ebaus,
  public.po_number_seq_ebgrp;
