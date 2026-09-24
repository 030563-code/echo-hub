-- Correcting a Nippon Express bill in the Hub, and saying it has been looked at.
--
-- Dean, 24 Sep 2026: "Some of the things say need a look but theres no way to edit in the Hub."
--
-- Two different things were missing, and the five bills flagged that day needed both:
--  - a misread figure, or a 7501 that came separately, has to be put right in the reading itself,
--    which the checks, the Xero draft and the landed cost are all worked from; and
--  - a flag that is true but understood (a rate Nippon filed on purpose, a bill with no duty on
--    it) has to be signed off by Dave, with a word on why, instead of saying "needs a look" for
--    ever.
--
-- extraction_original  what Claude read, kept the first time the reading is edited, so an edit
--                      can always be compared with the scan's first reading
-- edited_by_uid/_at    who changed the reading last
-- reviewed_*           Dave's sign-off, and reviewed_checks the checks it was given against: if the
--                      reading changes and the checks with it, the sign-off no longer applies
--
-- customs_bills is already service role only (20260923150000); new columns inherit that.

alter table public.customs_bills
  add column if not exists extraction_original jsonb,
  add column if not exists edited_by_uid uuid references auth.users (id) on delete set null,
  add column if not exists edited_at timestamptz,
  add column if not exists reviewed_by_uid uuid references auth.users (id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text check (review_note is null or length(btrim(review_note)) between 1 and 1000),
  add column if not exists reviewed_checks text;

comment on column public.customs_bills.reviewed_checks is
  'The checks as they stood when the bill was marked checked (src/lib/customs/view.ts, checksFingerprint). A different set means the sign-off no longer applies.';

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'customs_bills' and rowsecurity) then
    raise exception 'row level security is off on customs_bills';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'customs_bills' and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'anon or authenticated hold grants on customs_bills';
  end if;
end $$;
