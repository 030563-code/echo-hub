-- Files a reviewer attaches to a customer invoice.
--
-- The first use of Supabase Storage in this codebase, so the shape is set here
-- deliberately. document-data.ts argues against a bucket for the invoice PDF on
-- "who can reach the URL" grounds, and that reasoning still holds for the PDF:
-- it is deterministic, re-rendered on demand and verified by pdf_sha256, so
-- storing it would buy nothing. An attachment is the opposite case. It is a
-- file that exists nowhere else, so it has to be stored, and the URL question
-- is answered by making the bucket private and minting a short-lived signed URL
-- inside a server action that has already checked invoicing.manage.
--
-- Uploads do NOT go through a server action: Next's default request body limit
-- is 1 MB and base64 inflates by a third, which would cap a file near 750 KB.
-- The browser uploads straight to Storage with a signed upload token minted
-- server-side against a server-chosen path, so the bytes never touch the app
-- and a client can never name another invoice's folder.
--
-- APPLIED LIVE via MCP apply_migration (invoice_attachments) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

-- Private. The size limit and the MIME allowlist are enforced by Storage itself,
-- so a forged direct upload cannot get past them even though the signed token
-- bypasses RLS by design.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-attachments', 'invoice-attachments', false, 20971520,
  array['application/pdf','image/png','image/jpeg','image/webp',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/csv','text/plain'])
on conflict (id) do nothing;

-- No storage.objects policy on purpose. Uploads use a signed upload token and
-- downloads a signed url, both minted by the service role after a capability
-- check, so the browser never needs a policy and anon reaches nothing.

create table public.invoice_attachments (
  id                 uuid primary key default gen_random_uuid(),
  invoice_id         uuid not null references public.customer_invoices(id) on delete cascade,
  filename           text not null,
  -- The object key inside the bucket, always '<invoice_id>/<uuid>-<safe name>'.
  -- Unique so a replayed finish call cannot record the same object twice.
  storage_path       text not null unique,
  content_type       text,
  size_bytes         integer check (size_bytes is null or size_bytes >= 0),
  uploaded_by_uid    uuid,
  uploaded_by_label  text,
  -- Filled when the Xero leg ships: Xero returns an AttachmentID per file.
  xero_attachment_id text,
  created_at         timestamptz not null default now()
);

create index invoice_attachments_invoice_idx on public.invoice_attachments (invoice_id, created_at);

-- Lockdown doctrine (customer_invoices precedent): RLS on, revoke everything,
-- and NO grant and NO policy, which means service role only. Server actions
-- read and write it through the admin client after requireInvoicingManage.
-- Note po_attachments granted TRUNCATE to authenticated, which RLS does not
-- stop; that is not copied here.
alter table public.invoice_attachments enable row level security;
revoke all on public.invoice_attachments from public, anon, authenticated;

comment on table public.invoice_attachments is
  'Files a reviewer attaches to a customer invoice. Objects live in the private invoice-attachments bucket under <invoice_id>/. Service role only: no grant, no policy; reads and writes go through server actions after an invoicing.manage check, downloads by short-lived signed url.';
