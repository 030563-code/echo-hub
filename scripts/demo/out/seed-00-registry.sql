begin;

create table public.mrp_demo_seed_registry (
  id bigint generated always as identity primary key,
  batch_tag text not null,
  op text not null check (op in ('insert', 'update')),
  table_name text not null,
  pk jsonb not null,
  prior jsonb,
  created_at timestamptz not null default now()
);

alter table public.mrp_demo_seed_registry enable row level security;

revoke all on public.mrp_demo_seed_registry from anon, authenticated;

commit;
