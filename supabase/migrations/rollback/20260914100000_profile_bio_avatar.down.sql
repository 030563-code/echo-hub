-- Rollback for 20260914100000_profile_bio_avatar.sql.
--
-- Remove every object in the avatars bucket first, through the Storage API, not
-- by deleting rows. The bucket is deleted only when it is empty: while it still
-- holds objects the guarded delete below matches nothing and the bucket stays.
--
-- Storage has a statement-level BEFORE DELETE trigger, protect_buckets_delete,
-- on storage.buckets. It raises 42501 unless storage.allow_delete_query is
-- 'true', and a statement trigger fires even when no row matches, so without the
-- set_config the delete raises and aborts this whole rollback. The set_config is
-- transaction-local (its third argument is true) and only lets the guarded
-- delete below through; it ends with this transaction. Run the file as one
-- batch, so the set_config and the delete share that transaction.
--
-- The job titles and bios are lost with their columns; export them first if
-- they matter.

alter table public.profiles drop constraint if exists profiles_job_title_length;
alter table public.profiles drop constraint if exists profiles_bio_length;

revoke update (bio, job_title) on public.profiles from authenticated;

alter table public.profiles
  drop column if exists job_title,
  drop column if exists bio,
  drop column if exists avatar_updated_at;

select set_config('storage.allow_delete_query', 'true', true);

delete from storage.buckets
where id = 'avatars'
  and not exists (select 1 from storage.objects where bucket_id = 'avatars');
