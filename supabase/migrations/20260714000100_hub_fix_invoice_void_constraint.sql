-- Voiding a commercial invoice failed 100% of the time: two ANDed CHECK
-- constraints on status — the original {draft,issued,sent,superseded} and the
-- 2026-07-03 guard's {draft,issued,void} — intersect to {draft,issued}, so 'void'
-- was unreachable and the only invoice-correction path was dead. Drop the stale
-- original; the guard constraint (draft|issued|void) is the real one and already
-- validated every existing row when it was added. Data-safe (dropping a CHECK
-- touches no rows).
alter table public.commercial_invoices drop constraint if exists commercial_invoices_status_check;
