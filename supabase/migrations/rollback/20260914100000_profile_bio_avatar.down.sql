-- Rollback for 20260914100000_profile_bio_avatar.sql.
--
-- The avatars bucket is deleted only when it is empty. Remove the objects in it
-- first (through the Storage API, not by deleting rows), otherwise the bucket
-- delete below matches nothing and the photos stay behind. The job titles and
-- bios are lost with their columns; export them first if they matter.

alter table public.profiles drop constraint if exists profiles_job_title_length;
alter table public.profiles drop constraint if exists profiles_bio_length;

revoke update (bio, job_title) on public.profiles from authenticated;

alter table public.profiles
  drop column if exists job_title,
  drop column if exists bio,
  drop column if exists avatar_updated_at;

delete from storage.buckets
where id = 'avatars'
  and not exists (select 1 from storage.objects where bucket_id = 'avatars');
