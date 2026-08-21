-- Rep-authored comments shown on the quote PDF (the "Comments from <rep>" block
-- on Echo Barrier's HubSpot-native quotes: ship-from note, what the quote
-- assumes, layout/dimensions, what's optional). Stored so re-generating a quote
-- reproduces the same document. Table-level grants cover the new column.
-- ALREADY APPLIED LIVE via MCP (deals_registry_quote_comments). Never `db push`.
alter table public.deals_registry add column if not exists quote_comments text;

comment on column public.deals_registry.quote_comments is
  'Free-text comments the rep writes for the customer-facing quote PDF. Reproduced on re-generate.';
