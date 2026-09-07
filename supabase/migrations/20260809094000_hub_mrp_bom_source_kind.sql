-- These BOM rows are an ESTIMATE, and the schema must say so.
--
-- A delivery note records what one batch actually consumed. That is strong
-- evidence but it is not a bill of materials: it carries that run's scrap and
-- setup waste, and one observation cannot separate a standard quantity from a
-- one-off. Dean has confirmed an official BOM is coming later.
--
-- `verified` already means something narrower and is staying as it is: the row
-- is a faithful TRANSCRIPTION of the document (double-keyed, blind re-read,
-- 129/130 exact). Transcription accuracy and BOM authority are different
-- claims, and collapsing them is how an estimate quietly becomes a fact.

alter table public.mrp_bom_component
  add column if not exists source_kind text not null default 'delivery_note_estimate'
    check (source_kind in ('delivery_note_estimate', 'official_bom'));

comment on column public.mrp_bom_component.source_kind is
  'Provenance of the quantity. delivery_note_estimate = derived from a single observed batch (includes that run''s waste; not a standard). official_bom = supplied by Bamida/Echo Barrier as the engineering BOM. When the official BOM lands, insert alongside and switch the reads — do not overwrite, so the estimate stays available to diff against.';

comment on column public.mrp_bom_component.verified is
  'The row is a faithful TRANSCRIPTION of its source document — double-keyed (transcribed, then blind re-transcribed and diffed; 129 of 130 line-entries exact). This says NOTHING about whether the quantity is the correct standard for the product: see source_kind.';
