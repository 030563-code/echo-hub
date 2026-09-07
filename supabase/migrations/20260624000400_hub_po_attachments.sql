-- ============================================================================
-- Echo Barrier Hub — PO file attachments (SRO slice 5)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE — one private Storage bucket + one table. n8n PO flow untouched.
--
-- Attachments (vendor invoices, spec sheets, signed POs) live in a PRIVATE
-- `po-attachments` bucket. storage.objects keeps its default-deny RLS (no bucket
-- policy added) — ALL object access goes through capability-gated server actions
-- using the service-role client (upload / signed-url download / delete), matching
-- the "service_role server-side only" rule. The metadata table is readable by any
-- authenticated user (to list a PO's files); rows are written service-role-only.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'po-attachments', 'po-attachments', false,
  10485760,  -- 10 MB, matching the server action
  ARRAY['application/pdf','image/png','image/jpeg','image/webp','image/gif','text/plain','text/csv',
        'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.po_attachments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id           uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,
  filename        text NOT NULL,
  content_type    text,
  size_bytes      integer,
  uploaded_by_uid uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_attachments_po_id_idx ON public.po_attachments (po_id);

ALTER TABLE public.po_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.po_attachments FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.po_attachments FROM authenticated;
GRANT SELECT ON public.po_attachments TO authenticated;

-- Read: any authenticated user (matches purchase_orders read-all). Writes are
-- service-role only (the upload/delete actions, after a capability check).
DROP POLICY IF EXISTS "hub: read attachments" ON public.po_attachments;
CREATE POLICY "hub: read attachments"
  ON public.po_attachments FOR SELECT TO authenticated
  USING (true);
