-- A job title, a bio and a profile picture for every Hub user.
--
-- Until now a person in the Hub was an email address. The header and the
-- sidebar had nothing to show but that, and nobody could say who they are or
-- what they look after. This adds a job title, a short bio and a photo, all
-- set by the person themselves on /profile.
--
-- What changes:
--  - profiles.job_title: one line, capped at 80 characters by a CHECK. Shown
--    under the email in the sidebar footer.
--  - profiles.bio: free text, capped at 500 characters by a CHECK so the cap
--    holds even for a write that skips the app.
--  - profiles.avatar_updated_at: when the photo last changed. Null means no
--    photo. It doubles as the cache version in the image url, so a new photo
--    shows at once while an unchanged one is cached for a year.
--  - authenticated may UPDATE bio and job_title on its own row (RLS already
--    limits UPDATE to auth.uid() = id). Nothing else is granted:
--    avatar_updated_at is written only by the service role, after the server
--    has checked the upload really is a JPEG, PNG or WebP image, so nobody can
--    point their row at a photo that was never validated.
--  - a private 'avatars' bucket. One object per user, keyed by the user id
--    alone. There are NO storage.objects policies, the same doctrine as
--    po-attachments: every read and write goes through the service-role client
--    after a session check, and the image is served same-origin from
--    /api/avatar/<userId> because the CSP allows img-src 'self' only.
--
-- trg_profiles_guard_authz is deliberately untouched. Neither column is an
-- authorization column.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

alter table public.profiles
  add column job_title text,
  add column bio text,
  add column avatar_updated_at timestamptz;

alter table public.profiles
  add constraint profiles_job_title_length check (job_title is null or char_length(job_title) <= 80);

alter table public.profiles
  add constraint profiles_bio_length check (bio is null or char_length(bio) <= 500);

comment on column public.profiles.job_title is
  'The job title the user sets on /profile. One line, at most 80 characters.';
comment on column public.profiles.bio is
  'A short bio the user writes about themselves on /profile. At most 500 characters.';
comment on column public.profiles.avatar_updated_at is
  'When the profile photo in the avatars bucket last changed. Null means no photo. Written by the service role only.';

grant update (bio, job_title) on public.profiles to authenticated;

-- Private. The size limit and the MIME allowlist are enforced by Storage
-- itself as a backstop. The server action is the real gate: it refuses any
-- file whose leading bytes are not one of these three formats, whatever type
-- the browser declared.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 524288,
  array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
