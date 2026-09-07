-- Follow-up to hub_bamida_ns_number_key. The live sync (workflow
-- Rsu0SnGdhwLWlPR8, active version c82f433b) now upserts
-- on_conflict=ns_number, verified by a real run: 112 cards matched in place,
-- 112 history rows written with a key, nothing deactivated. The item_name
-- unique constraint has therefore stopped being load-bearing and is now
-- actively harmful.
--
-- Why it must go rather than stay as harmless belt-and-braces: it is the exact
-- failure this migration set exists to prevent. If Bamida re-types a Slovak
-- name into one another card already uses — or swaps two names — the upsert
-- would violate it and the whole daily batch POST would fail, taking material
-- visibility offline for the MRP buffer engine. Identity is ns_number; names
-- are display text and are allowed to collide.

alter table public.bamida_material_stock
  drop constraint if exists bamida_material_stock_item_name_key;

-- Keep name lookups fast (Slack output, human search, the legacy
-- mrp_bom_map.bamida_item_name join) without asserting uniqueness.
create index if not exists bamida_material_stock_item_name_idx
  on public.bamida_material_stock (item_name);
