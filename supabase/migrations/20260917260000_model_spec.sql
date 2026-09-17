-- The manufacturing specification, per barrier model.
--
-- Juraj, 17 Sep 2026, asked for far more detail on the manufacturing order file and pointed at a
-- folder of per-product templates plus sample orders. Until now the Hub's -1 document printed the
-- bill of materials, a pallet count and the single word "Standard" for printing, because no
-- colour, artwork, material or packing field existed anywhere in either database.
--
-- Source of truth is Bamida's own OBJEDNÁVKOVÝ LIST documents: 13 product templates plus the
-- sample orders Dean supplied for the models that have no template (PO-00001413 is H9,
-- PO-00001398 is the Japanese H10). source_document records which one each row came from, so a
-- disputed value can be argued from the paper it was read off.
--
-- 🔴 `confirmed` is false on every row until Juraj signs it off, and the document prints that on
-- its face. A spec read out of one historic order is evidence, not a standing instruction:
-- PO-00001398 carries Japanese graphics and a Japan-only hook and lanyard pack, which are that
-- order's requirements and not necessarily the model's.
create table if not exists public.model_spec (
  -- Matches product_code_master.bom_model_code and po_product_catalog.bom_model_code.
  model_code text primary key,
  product_label text not null,
  dimensions text,

  graphics_print text,
  graphics_notes text[],
  graphics_with_logo text,

  pvc_type text,
  pvc_ral text,
  pvc_colour text,

  mesh_type text,
  mesh_colour text,

  goretex_type text,
  goretex_colour text,

  infill_type text,
  infill_dimensions text,

  thread_type text,
  thread_colour text,

  reflective_type text,
  reflective_colour text,

  rings text,
  buckles text,

  pallet_type text,
  construction text,
  max_pallet_height text,

  specific_requirements text[],
  -- BALENIE: the pack configuration, e.g. "9x70 ks". Drives the pallet count, so it matters more
  -- than its size suggests, and it is the thinnest field in the source documents.
  pack_config text,
  -- PRIBALIŤ: what to include in the shipment beyond the barriers themselves.
  include_with_order text,

  source_document text not null,
  confirmed boolean not null default false,
  confirmed_by text,
  confirmed_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);

comment on table public.model_spec is
  'The manufacturing specification per barrier model, read from Bamida OBJEDNAVKOVY LIST templates and sample orders. Printed on the -1 manufacturing specification document. confirmed=false means Juraj has not signed the row off and the document prints it as unconfirmed rather than as an instruction.';

create index if not exists idx_model_spec_confirmed on public.model_spec (confirmed);

alter table public.model_spec enable row level security;

drop policy if exists "hub: read model_spec" on public.model_spec;
create policy "hub: read model_spec"
  on public.model_spec for select to authenticated
  using ((select public.is_internal()));

-- Editing a spec is editing what the factory is told to build, so it sits behind the same
-- capability as the master prices rather than being open to every signed-in account.
drop policy if exists "hub: write model_spec" on public.model_spec;
create policy "hub: write model_spec"
  on public.model_spec for all to authenticated
  using ((select public.has_capability('bom.edit')))
  with check ((select public.has_capability('bom.edit')));

revoke all on public.model_spec from public, anon, authenticated;
grant select on public.model_spec to authenticated;
grant insert, update on public.model_spec to authenticated;
grant all on public.model_spec to service_role;

-- The 15 seeded rows (13 templates plus H9 and the Japanese H10 read from the two sample orders)
-- were loaded separately and are reproducible from
-- Obsidian: Echo Barrier/Stocks Prediction Module/bamida-spec-templates/specs.json.
-- 🔴 One extraction artefact was corrected on the way in: several templates recorded a three digit
-- "RAL" (606, 636) which is the L&B fabric suffix, not a RAL colour. Real RAL codes here are four
-- digits (6026, 6005). Those values were moved onto the fabric line and the RAL left null and
-- noted, rather than printing a fabric code to the factory as a colour standard.
