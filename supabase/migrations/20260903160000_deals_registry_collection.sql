-- Will Call on the deal, so the answer the rep gives at Quote Setup reaches the
-- customer invoice without being asked a second time.
--
-- customer_invoices.is_collection (20260902000000) already drives the TaxJar
-- destination, the filing and the COLLECTION block on the PDF. What was missing
-- was a carrier: every invoice opened from the queue started delivered because
-- nothing upstream held the answer. This column is that carrier. It is written
-- by the rep at Quote Setup, confirmed at Quotation Accepted, and read once when
-- the draft invoice is opened. The invoice keeps its own flag, and the editor
-- checkbox stays the value the invoice pipeline trusts.
--
-- Additive only. NOT NULL DEFAULT false backfills every existing row as
-- delivered, which is what they all are. Deliberately no UPDATE: deals_registry
-- carries an unconditional AFTER trigger that POSTs every touched row to n8n and
-- a BEFORE trigger that rewrites line_items_raw, so a backfill UPDATE would fire
-- both across 2,000+ rows. ADD COLUMN with a constant default is a catalogue
-- change and fires neither.
--
-- Table-level grants and the region RLS policies already cover the new column;
-- nothing new is granted to anon or authenticated. Compatible with the pending
-- delivery-guards migration: a collected deal carries zero delivery_* fields,
-- which that all-or-none CHECK allows.
--
-- APPLIED LIVE via MCP apply_migration (deals_registry_collection) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

alter table public.deals_registry
  add column if not exists is_collection boolean not null default false;

comment on column public.deals_registry.is_collection is
  'Will Call: the customer collects from the sending depot. Set at Quote Setup, confirmed at Quotation Accepted, seeds customer_invoices.is_collection when the draft invoice is opened. Hub-owned; n8n never writes it.';
