-- Undo 20260918110000_po_attachment_share_with_manufacturer.sql.
--
-- 🔴 REVERT THE CODE FIRST. src/lib/factory/orders.ts filters on this column in
-- both loadFactoryDocuments and factorySharedFile, and src/lib/po-detail.ts and
-- the purchase-order board both select it. Dropping the column under a deployed
-- Hub turns the factory's file list and the office's tick into errors.
--
-- What is lost: which files somebody ticked for the manufacturer, and nothing
-- else. The attachments and their storage objects are untouched. Re-applying
-- the migration brings every file back as internal, which is the safe
-- direction: a file that was shared becomes unshared, never the reverse.

alter table public.po_attachments drop column if exists share_with_manufacturer;
