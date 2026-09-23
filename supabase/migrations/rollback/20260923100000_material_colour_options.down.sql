-- Undo 20260923100000_material_colour_options.
--
-- Drops the picklist and its policies with it. A saved specification keeps any colour already
-- chosen on its material lines: that is part of the signed document (po_spec_document.draft),
-- not of this table, and the editor still shows it as the value it holds.
drop table if exists public.material_colour_option;
