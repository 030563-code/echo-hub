-- Xero tracking categories per invoice line (Dean, 2026-09-03).
--
-- Shape verified against Xero's own OpenAPI spec, not a blog:
-- https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml
--   LineItem.Tracking: "Optional Tracking Category - see Tracking. Any LineItem
--   can have a maximum of 2 <TrackingCategory> elements."
--   LineItemTracking: { TrackingCategoryID, TrackingOptionID, Name, Option }
--
-- Stored in our own camelCase shape and translated at the boundary, so a change
-- in Xero's casing does not reach into the database.
--
-- APPLIED LIVE via MCP apply_migration (invoice_line_tracking) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

alter table public.customer_invoice_lines
  add column if not exists tracking jsonb not null default '[]'::jsonb;

-- The limit is enforced here as well as in the UI, because the Xero call goes
-- out through n8n and a payload Xero rejects surfaces as an opaque failure
-- halfway through a send rather than as a message on the line that caused it.
alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_tracking_max_two;
alter table public.customer_invoice_lines
  add constraint customer_invoice_lines_tracking_max_two
  check (jsonb_typeof(tracking) = 'array' and jsonb_array_length(tracking) <= 2);

comment on column public.customer_invoice_lines.tracking is
  'Xero tracking, as [{categoryId, categoryName, optionId, optionName}]. Max 2 per line, which is Xero''s documented limit. Sent to Xero as LineItem.Tracking [{TrackingCategoryID, TrackingOptionID, Name, Option}].';
