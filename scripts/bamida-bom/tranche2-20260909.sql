-- Bamida delivery-note bills of materials, second tranche.
--
-- 18 delivery notes covering 19 product observations, transcribed line by line
-- and each independently re-read and diffed by a second pass. Source PDFs are
-- Bamida dodacie listy: they record what was CONSUMED to build one batch, and
-- carry no prices.
--
-- The consumption model is two-tier and was re-confirmed here on ten products
-- (it was five before):
--     required(q) = per_unit * q + per_pallet * ceil(q / pallet_size)
-- Eight packaging lines came out constant per pallet across every product that
-- has them, which is what makes the model credible rather than merely fitted.
--
-- SCOPE. This migration is strictly additive:
--   * mrp_bom_observation(_line) is new and nothing reads it yet. It holds all
--     19 observations, so the next delivery note is a diff and not another
--     re-derivation from scratch.
--   * mrp_bom_product / mrp_bom_component gain the THIRTEEN products that have
--     no bill of materials at all today. Nothing can regress: with no
--     mrp_bom_sku_map row they stay inert until somebody maps a Hub SKU.
--   * The five products that already have a bill of materials are NOT touched.
--     Their newer notes disagree in places, most importantly H10, and changing
--     a live manufacturing ceiling is a decision for Dean and Juraj, not a
--     migration.


-- ============================================================ 19 observations
insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000722', 'Výroba Echo Barrier CSC (komplet stan)', 'DLE26070002', '2026-07-02', 'PO-00001380', 2, 1, 2, null, array['batch of 2 filled one pallet, so pallet size is only known to be >= 2','code 3097 appeared 2x on the same basis and was summed','code 611 appeared 2x on the same basis and was summed']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 50, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 1, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 20, true),
    ('000340', 'UV tlač + manipulácia', 15, 'min', 'per_unit', 'operation', 30, false),
    ('000406', 'Zváranie VF-SPIDER XYZ', 0, 'min', 'per_unit', 'operation', 0, false),
    ('000457', 'Grafika - súbory pre tlač', 45, 'min', 'per_unit', 'operation', 90, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 210, 'min', 'per_unit', 'operation', 420, false),
    ('000651', 'Cutter- rez', 20, 'min', 'per_unit', 'operation', 40, false),
    ('000657', 'EuroLaser - rez', 20, 'min', 'per_unit', 'operation', 40, false),
    ('000852', 'Zváranie Echobarrier VF', 1, 'ks', 'per_unit', 'operation', 2, false),
    ('1566', 'Suchý zips 10 cm čierny háčik 102', 11, 'm', 'per_unit', 'material', 22, true),
    ('1567', 'Suchý zips 10 cm čierny vlas 102', 35.5, 'm', 'per_unit', 'material', 71, true),
    ('1972', 'PVC mäkčené pásy Standart 2/200mm', 9.6, 'm', 'per_unit', 'material', 19.2, true),
    ('1973', 'PVC mäkčené pásy Standart 3/300mm', 16, 'm', 'per_unit', 'material', 32, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 270, 'm', 'per_unit', 'material', 540, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 6, 'm', 'per_unit', 'material', 12, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.4, 'l', 'per_unit', 'material', 0.8, false),
    ('2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 1.2, 'm2', 'per_unit', 'material', 2.4, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 4, 'm', 'per_unit', 'material', 8, true),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 395, 'm', 'per_unit', 'material', 790, true),
    ('311', 'Uv potlač Echobarrier CSC s logom CIVILS', 1, 'ks', 'per_unit', 'intermediate', 2, false),
    ('356', 'zváranie strechy + lamepy', 90, 'min', 'per_unit', 'operation', 180, false),
    ('478', 'Západkový uzáver', 2, 'ks', 'per_unit', 'material', 4, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 40, 'm2', 'per_unit', 'material', 80, true),
    ('548', 'Pás PVC navarovaci šírky 48mm čierny', 4.5, 'm', 'per_unit', 'material', 9, false),
    ('605', 'Lemovka- Popruh PP 31S900 10/1/25', 2, 'm', 'per_unit', 'material', 4, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 73, 'm', 'per_unit', 'material', 146, true),
    ('611', 'Suchý zips 50 mm, čierny- háčik', 12.5, 'm', 'per_unit', 'material', 25, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000722' and o.source_doc = 'DLE26070002'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000723', 'Výroba Echo Barrier CS R10 (komplet stan)', 'DLE26070001', '2026-07-02', 'PO-00001376', 10, 2, 5, 9, array['pallet size is only pinned to 5..9 by this note','code 3097 appeared 2x on the same basis and was summed','code 611 appeared 2x on the same basis and was summed']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 100, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 2, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 40, true),
    ('000340', 'UV tlač + manipulácia', 16, 'min', 'per_unit', 'operation', 160, false),
    ('000457', 'Grafika - súbory pre tlač', 3, 'min', 'per_unit', 'operation', 30, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 210, 'min', 'per_unit', 'operation', 2100, false),
    ('000651', 'Cutter- rez', 20, 'min', 'per_unit', 'operation', 200, false),
    ('000657', 'EuroLaser - rez', 20, 'min', 'per_unit', 'operation', 200, false),
    ('000852', 'Zváranie Echobarrier VF R10', 1, 'ks', 'per_unit', 'operation', 10, false),
    ('1566', 'Suchý zips 10 cm čierny háčik 102', 25, 'm', 'per_unit', 'material', 250, true),
    ('1567', 'Suchý zips 10 cm čierny vlas 102', 45, 'm', 'per_unit', 'material', 450, true),
    ('1972', 'PVC mäkčené pásy Standart 2/200mm', 9.6, 'm', 'per_unit', 'material', 96, true),
    ('1973', 'PVC mäkčené pásy Standart 3/300mm', 16, 'm', 'per_unit', 'material', 160, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 410, 'm', 'per_unit', 'material', 4100, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 6.5, 'm', 'per_unit', 'material', 65, true),
    ('263', 'Pozinkované krúžky 10mm', 4, 'ks', 'per_unit', 'material', 40, false),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.05, 'l', 'per_unit', 'material', 0.5, false),
    ('2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.9, 'm2', 'per_unit', 'material', 9, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 17.5, 'm', 'per_unit', 'material', 175, true),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 517, 'm', 'per_unit', 'material', 5170, true),
    ('311', 'Uv potlač Echobarrier R10', 1, 'ks', 'per_unit', 'intermediate', 10, false),
    ('356', 'zváranie lamiel + strecha', 120, 'min', 'per_unit', 'operation', 1200, false),
    ('478', 'Západkový uzáver', 2, 'ks', 'per_unit', 'material', 20, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 52.5, 'm2', 'per_unit', 'material', 525, true),
    ('548', 'Pás PVC navarovaci šírky 48mm čierny', 4, 'm', 'per_unit', 'material', 40, false),
    ('605', 'Lemovka- Popruh PP 31S900 10/1/25', 2.6, 'm', 'per_unit', 'material', 26, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 107, 'm', 'per_unit', 'material', 1070, true),
    ('611', 'Suchý zips 50 mm, čierny- háčik', 20, 'm', 'per_unit', 'material', 200, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000723' and o.source_doc = 'DLE26070001'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000975', 'Výroba Echo Barrier Gen set extension (752 x 3983,7 mm)', 'DLE26050003', '2026-05-12', 'PO-00001327', 100, null, null, null, array['no packing-bag line, so no pallet count and no per-pallet rates']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000289', 'Práca - šitie', 30, 'min', 'per_unit', 'operation', 3000, false),
    ('000309', 'Balenie', 2, 'min', 'per_unit', 'operation', 200, false),
    ('000328', 'Práca- Vybitie krúžkov', 12, 'min', 'per_unit', 'operation', 1200, false),
    ('000340', 'UV tlač + manipulácia', 2, 'min', 'per_unit', 'operation', 200, false),
    ('000457', 'Grafika - súbory pre tlač', 0.3, 'min', 'per_unit', 'operation', 30, false),
    ('000651', 'Cutter- rez', 3, 'min', 'per_unit', 'operation', 300, false),
    ('000657', 'EuroLaser - rez', 4, 'min', 'per_unit', 'operation', 400, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 50, 'm', 'per_unit', 'material', 5000, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0072, 'l', 'per_unit', 'material', 0.72, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 6, 'm', 'per_unit', 'material', 600, true),
    ('311', 'Uv potlač Echobarrier Gen set extension', 1, 'ks', 'per_unit', 'intermediate', 100, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 3.65, 'm2', 'per_unit', 'material', 365, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 10, 'm', 'per_unit', 'material', 1000, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 31, 'ks', 'per_unit', 'material', 3100, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000975' and o.source_doc = 'DLE26050003'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('30049', 'Výroba Echo Barrier Gen set M1', 'DLE26030003', '2026-03-04', 'PO-00001290', 10, 1, 10, null, array['batch of 10 filled one pallet, so pallet size is only known to be >= 10']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 1, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 1, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 1, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 6, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 16, false),
    ('376', 'KAROS. PODLOŽKA ZI 5X20', 10.5, 'ks', 'per_pallet', 'material', 10.5, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 20, true),
    ('000289', 'Práca - šitie', 260, 'min', 'per_unit', 'operation', 2600, false),
    ('000340', 'UV tlač + manipulácia', 3, 'min', 'per_unit', 'operation', 30, false),
    ('000457', 'Grafika - súbory pre tlač', 3, 'min', 'per_unit', 'operation', 30, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 20, 'min', 'per_unit', 'operation', 200, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 20, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 20, false),
    ('000852', 'Zváranie Echobarrier VF GEN set M1', 1, 'ks', 'per_unit', 'operation', 10, false),
    ('1566', 'Suchý zips 10 cm čierny háčik 102', 20, 'm', 'per_unit', 'material', 200, true),
    ('1567', 'Suchý zips 10 cm čierny vlas 102', 12, 'm', 'per_unit', 'material', 120, true),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 227, 'm', 'per_unit', 'material', 2270, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 3, 'm', 'per_unit', 'material', 30, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.007, 'l', 'per_unit', 'material', 0.07, false),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 187, 'm', 'per_unit', 'material', 1870, true),
    ('311', 'Uv potlač Echobarrier Gen set M1', 1, 'ks', 'per_unit', 'intermediate', 10, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 15, 'm2', 'per_unit', 'material', 150, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 40, 'm', 'per_unit', 'material', 400, true),
    ('900', 'Serge Ferrari meshes 362- 50201 zelená', 15, 'm2', 'per_unit', 'material', 150, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '30049' and o.source_doc = 'DLE26030003'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000728', 'Výroba Echo Barrier H10 (1335 x 2050 mm)', 'DLE26080011', '2026-08-28', 'PO-00001409', 350, 5, 70, 87, array['pallet size is only pinned to 70..87 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 5, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 250, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 5, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 5, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 30, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 80, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 50, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 100, true),
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 3500, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 1400, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 87.5, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 1400, false),
    ('000340', 'UV tlač + manipulácia', 2.1, 'min', 'per_unit', 'operation', 735, false),
    ('000457', 'Grafika - súbory pre tlač', 0.042857, 'min', 'per_unit', 'operation', 15, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 700, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 700, false),
    ('000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', 1400, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', 13650, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', 598.5, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.007143, 'l', 'per_unit', 'material', 2.5, false),
    ('2926', 'SQP, UV - Ink 5L ( Farby Nyala )', 0.001714, 'l', 'per_unit', 'material', 0.6, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 1750, true),
    ('311', 'Uv potlač Echobarrier H10', 1, 'ks', 'per_unit', 'intermediate', 350, false),
    ('4376', 'SQA, Primer 1 liter', 0.000571, 'l', 'per_unit', 'material', 0.2, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', 997.5, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', 2450, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', 6650, true),
    ('897', 'Sieťka 362- zelená (2050x1335 mm)', 1, 'ks', 'per_unit', 'material', 350, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000728' and o.source_doc = 'DLE26080011'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000762', 'Výroba Echo Barrier H10 s prackou+ navarovacia reflexná páska (1335 x 2050 mm)', 'DLE26080007', '2026-08-18', 'PO-00001397', 520, 8, 65, 74, array['pallet size is only pinned to 65..74 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000856', 'Račňa textilná Echobarrier', 10, 'ks', 'per_order', 'material', 10, false),
    ('662', 'Račna s pásom 50mm + račnový pás komplet', 10, 'ks', 'per_order', 'material', 10, false),
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 8, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 400, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 48, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 128, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 80, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 160, true),
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 5200, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 2080, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 130, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 2080, false),
    ('000340', 'UV tlač + manipulácia', 1.846154, 'min', 'per_unit', 'operation', 960, false),
    ('000457', 'Grafika - súbory pre tlač', 0.028846, 'min', 'per_unit', 'operation', 15, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 1040, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 1040, false),
    ('000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', 2080, false),
    ('000714', 'Vybitie pracky', 2, 'min', 'per_unit', 'operation', 1040, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', 20280, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', 889.2, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0075, 'l', 'per_unit', 'material', 3.9, false),
    ('2926', 'SQP, UV - Ink 5L ( Farby Nyala )', 0.000769, 'l', 'per_unit', 'material', 0.4, false),
    ('300', 'Plastová podložka pod nity A-25/35.25', 1, 'ks', 'per_unit', 'material', 520, true),
    ('301', 'Plastová podložka pod nity 35.51', 2, 'ks', 'per_unit', 'material', 1040, true),
    ('303', 'Nit zaklepavaci', 4, 'ks', 'per_unit', 'material', 2080, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 2600, true),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 0.22, 'm', 'per_unit', 'material', 114.4, true),
    ('311', 'Uv potlač Echobarrier H 10', 1, 'ks', 'per_unit', 'intermediate', 520, false),
    ('4376', 'SQA, Primer 1 liter', 0.000192, 'l', 'per_unit', 'material', 0.1, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', 1482, true),
    ('605', 'Lemovka- Popruh PP 31S900 10/1/25', 0.7, 'm', 'per_unit', 'material', 364, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', 3640, true),
    ('621', 'FS 25 NY Pracka čierna 25 mm', 1, 'ks', 'per_unit', 'material', 520, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', 9880, true),
    ('897', 'Sieťka 362- zelená (2050x1335 mm)', 1, 'ks', 'per_unit', 'material', 520, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000762' and o.source_doc = 'DLE26080007'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000957', 'Výroba Echo Barrier H2 (1335 x 2050 mm)', 'DLE26070011', '2026-07-30', 'PO-00001411', 2, null, null, null, array['no packing-bag line, so no pallet count and no per-pallet rates']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 20, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 0.5, false),
    ('000340', 'UV tlač + manipulácia', 0, 'min', 'per_unit', 'operation', 0, false),
    ('000457', 'Grafika - súbory pre tlač', 5, 'min', 'per_unit', 'operation', 10, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 4, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 4, false),
    ('000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', 4, false),
    ('000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', 8, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', 78, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', 3.42, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.01, 'l', 'per_unit', 'material', 0.02, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 10, true),
    ('311', 'Uv potlač Echobarrier H2', 1, 'ks', 'per_unit', 'intermediate', 2, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', 5.7, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', 14, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', 38, true),
    ('900', 'Serge Ferrari meshes 362- 50201 zelená', 2.85, 'm2', 'per_unit', 'material', 5.7, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000957' and o.source_doc = 'DLE26070011'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000717', 'Výroba Echo Barrier H8 (3650 x 2050 mm)', 'DLE26080012', '2026-08-31', 'PO-00001414', 270, 9, 30, 33, array['pallet size is only pinned to 30..33 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 9, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 450, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 54, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 144, false),
    ('382', 'KAROS. PODLOŽKA ZI 6X30', 10, 'ks', 'per_pallet', 'material', 90, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 180, true),
    ('000308', 'Šitie', 15, 'min', 'per_unit', 'operation', 4050, false),
    ('000309', 'Balenie', 6, 'min', 'per_unit', 'operation', 1620, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 67.5, false),
    ('000328', 'Práca- Vybitie krúžkov', 8, 'min', 'per_unit', 'operation', 2160, false),
    ('000340', 'UV tlač + manipulácia', 5.6, 'min', 'per_unit', 'operation', 1512, false),
    ('000457', 'Grafika - súbory pre tlač', 0.055556, 'min', 'per_unit', 'operation', 15, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 30, 'min', 'per_unit', 'operation', 8100, false),
    ('000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', 675, false),
    ('000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', 675, false),
    ('000852', 'Zváranie Echobarrier VF H8', 1, 'ks', 'per_unit', 'operation', 270, false),
    ('1424', 'Mehler 8509-636 zelena', 9.12, 'm2', 'per_unit', 'material', 2462.4, true),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 32, 'm', 'per_unit', 'material', 8640, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 5.5, 'm', 'per_unit', 'material', 1485, true),
    ('269', 'Mosadzné krúžky 25mm', 4, 'ks', 'per_unit', 'material', 1080, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.017778, 'l', 'per_unit', 'material', 4.8, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 9, 'm', 'per_unit', 'material', 2430, true),
    ('311', 'Uv potlač Echobarrier H8', 1, 'ks', 'per_unit', 'intermediate', 270, false),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 12, 'm', 'per_unit', 'material', 3240, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 31, 'ks', 'per_unit', 'material', 8370, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000717' and o.source_doc = 'DLE26080012'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000716', 'Výroba Echo Barrier H9 (1335 x 2050 mm)', 'DLE26090002', '2026-09-02', 'PO-00001405', 560, 8, 70, 79, array['pallet size is only pinned to 70..79 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000856', 'Račňa textilná Echobarrier', 10, 'ks', 'per_order', 'material', 10, false),
    ('662', 'Račna s pásom 50mm + račnový pás komplet', 10, 'ks', 'per_order', 'material', 10, false),
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 8, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 400, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 48, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 128, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 80, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 160, true),
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 5600, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 140, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 2240, false),
    ('000340', 'UV tlač + manipulácia', 1.535714, 'min', 'per_unit', 'operation', 860, false),
    ('000457', 'Grafika - súbory pre tlač', 0.026786, 'min', 'per_unit', 'operation', 15, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 1120, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 1120, false),
    ('000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', 1120, false),
    ('000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', 2240, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', 21840, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', 957.6, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0075, 'l', 'per_unit', 'material', 4.2, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 2800, true),
    ('311', 'Uv potlač Echobarrier H9', 1, 'ks', 'per_unit', 'intermediate', 560, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', 1596, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', 3920, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', 10640, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000716' and o.source_doc = 'DLE26090002'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000751', 'Výroba Echo Barrier H9 mini (1010 x 658 mm)', 'DLE25020008', '2025-02-25', 'PO-00001089', 180, null, null, null, array['note supplied as a PARTIAL extract; its packaging covers products not in any file we hold, so no per-pallet rate is derived']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 7, 'min', 'per_unit', 'operation', 1260, false),
    ('000309', 'Balenie', 2, 'min', 'per_unit', 'operation', 360, false),
    ('000326', 'Rezanie reflexnej pásky', 0.15, 'min', 'per_unit', 'operation', 27, false),
    ('000328', 'Práca- Vybitie krúžkov', 8, 'min', 'per_unit', 'operation', 1440, false),
    ('000340', 'UV tlač + manipulácia', 0.75, 'min', 'per_unit', 'operation', 135, false),
    ('000457', 'Grafika - súbory pre tlač', 0.083333, 'min', 'per_unit', 'operation', 15, false),
    ('000651', 'Cutter- rez', 1, 'min', 'per_unit', 'operation', 180, false),
    ('000657', 'EuroLaser - rez', 1, 'min', 'per_unit', 'operation', 180, false),
    ('000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', 360, false),
    ('000713', 'Lepenie bavlny', 2, 'min', 'per_unit', 'operation', 360, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 9.5, 'm', 'per_unit', 'material', 1710, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1, 'm', 'per_unit', 'material', 180, true),
    ('264', 'Pozinkované krúžky 12mm', 19, 'ks', 'per_unit', 'material', 3420, false),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.001611, 'l', 'per_unit', 'material', 0.29, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 2, 'm', 'per_unit', 'material', 360, true),
    ('311', 'Uv potlač Echobarrier H9mini', 1, 'ks', 'per_unit', 'intermediate', 180, false),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 3.5, 'm', 'per_unit', 'material', 630, true),
    ('903', 'H5673 - 6026-1 (zelená)', 0.85, 'm2', 'per_unit', 'material', 153, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000751' and o.source_doc = 'DLE25020008'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000967', 'Výroba Echo Barrier H9J (1270x1030 mm)', 'DLE26020004', '2026-02-11', 'PO-00001293', 1, null, null, null, array['no packing-bag line, so no pallet count and no per-pallet rates']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 5, 'min', 'per_unit', 'operation', 5, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 0.25, false),
    ('000328', 'Práca- Vybitie krúžkov', 3, 'min', 'per_unit', 'operation', 3, false),
    ('000340', 'UV tlač + manipulácia', 15, 'min', 'per_unit', 'operation', 15, false),
    ('000457', 'Grafika - súbory pre tlač', 30, 'min', 'per_unit', 'operation', 30, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 2, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 2, false),
    ('000664', 'Zváranie VF-ZEMAT', 1, 'min', 'per_unit', 'operation', 1, false),
    ('000713', 'Lepenie bavlny', 2, 'min', 'per_unit', 'operation', 2, false),
    ('1621', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 15, 'm', 'per_unit', 'material', 15, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 0.75, 'm', 'per_unit', 'material', 0.75, true),
    ('2926', 'SQP, UV - Ink 5L ( Farby Nyala )', 0.01, 'l', 'per_unit', 'material', 0.01, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3.85, 'm', 'per_unit', 'material', 3.85, true),
    ('311', 'Uv potlač Echobarrier H9J', 1, 'ks', 'per_unit', 'intermediate', 1, false),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 4.8, 'm', 'per_unit', 'material', 4.8, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 15, 'ks', 'per_unit', 'material', 15, true),
    ('827', 'Mehler 8540 - 543 polymar sidecurtain CL II lesklá', 1.42, 'm2', 'per_unit', 'material', 1.42, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000967' and o.source_doc = 'DLE26020004'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('30050', 'Výroba Echo Barrier H9W', 'DLE25020008', '2025-02-25', 'PO-00001089', 70, null, null, null, array['note supplied as a PARTIAL extract; its packaging covers products not in any file we hold, so no per-pallet rate is derived']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 700, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 280, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 17.5, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 280, false),
    ('000340', 'UV tlač + manipulácia', 2.571429, 'min', 'per_unit', 'operation', 180, false),
    ('000457', 'Grafika - súbory pre tlač', 0.214286, 'min', 'per_unit', 'operation', 15, false),
    ('000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', 175, false),
    ('000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', 175, false),
    ('000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', 140, false),
    ('000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', 280, false),
    ('000852', 'Zváranie Echobarrier H9W', 1, 'ks', 'per_unit', 'operation', 70, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 40, 'm', 'per_unit', 'material', 2800, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', 119.7, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.007429, 'l', 'per_unit', 'material', 0.52, false),
    ('2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.5, 'm2', 'per_unit', 'material', 35, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3, 'm', 'per_unit', 'material', 210, true),
    ('311', 'Uv potlač Echobarrier H9W', 1, 'ks', 'per_unit', 'intermediate', 70, false),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', 490, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', 1330, true),
    ('903', 'H5673 - 6026-1 (zelená)', 3, 'm2', 'per_unit', 'material', 210, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '30050' and o.source_doc = 'DLE25020008'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000726', 'Výroba Echo Barrier H9X (1335 x 2550 mm)', 'DLE26020003', '2026-02-10', 'PO-00001280', 400, 8, 50, 57, array['pallet size is only pinned to 50..57 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1838', 'Textilné račne', 10, 'ks', 'per_order', 'material', 10, false),
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 8, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 8, false),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 50, 'm', 'per_pallet', 'material', 400, true),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 48, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 128, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 80, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 160, true),
    ('000308', 'Šitie', 30, 'min', 'per_unit', 'operation', 12000, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 1600, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 100, false),
    ('000328', 'Práca- Vybitie krúžkov', 5, 'min', 'per_unit', 'operation', 2000, false),
    ('000340', 'UV tlač + manipulácia', 2.375, 'min', 'per_unit', 'operation', 950, false),
    ('000457', 'Grafika - súbory pre tlač', 0.075, 'min', 'per_unit', 'operation', 30, false),
    ('000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', 800, false),
    ('000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', 800, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 14.8175, 'm', 'per_unit', 'material', 5927, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 2, 'm', 'per_unit', 'material', 800, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0075, 'l', 'per_unit', 'material', 3, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 7, 'm', 'per_unit', 'material', 2800, true),
    ('311', 'Uv potlač Echobarrier H9x', 1, 'ks', 'per_unit', 'intermediate', 400, false),
    ('356', 'rez bavlna', 1.5, 'min', 'per_unit', 'operation', 600, false),
    ('4713', 'Magnet KV-30-20-05-N', 2, 'ks', 'per_unit', 'material', 800, true),
    ('50', 'Sioline B6148- 6444 (zelená) 900g 2,67 x 54 m', 0.9, 'm2', 'per_unit', 'material', 360, true),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 3.6, 'm2', 'per_unit', 'material', 1440, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 8, 'm', 'per_unit', 'material', 3200, true),
    ('662', 'Račna s pásom 50mm + račnový pás komplet', 0.025, 'ks', 'per_unit', 'material', 10, false),
    ('7', 'Mosadzné krúžky 25mm - automatické', 23, 'ks', 'per_unit', 'material', 9200, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000726' and o.source_doc = 'DLE26020003'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000750', 'Výroba Echo Barrier HT 3,5 (3650 x 2050mm)', 'DLE26080008', '2026-08-19', 'PO-00001369', 120, 4, 30, 39, array['pallet size is only pinned to 30..39 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 4, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 200, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 4, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 4, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 24, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 64, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 40, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 80, true),
    ('000306', 'Nabitie krúžkov', 4, 'min', 'per_unit', 'operation', 480, false),
    ('000309', 'Balenie', 5, 'min', 'per_unit', 'operation', 600, false),
    ('000340', 'UV tlač + manipulácia', 6.333333, 'min', 'per_unit', 'operation', 760, false),
    ('000457', 'Grafika - súbory pre tlač', 0.125, 'min', 'per_unit', 'operation', 15, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 30, 'min', 'per_unit', 'operation', 3600, false),
    ('000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', 300, false),
    ('000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', 300, false),
    ('000692', 'Zváranie Leister Sematec', 10, 'min', 'per_unit', 'operation', 1200, false),
    ('000713', 'Lepenie bavlny', 1, 'min', 'per_unit', 'operation', 120, false),
    ('000852', 'Zváranie Echobarrier VF HT 3,5', 1, 'ks', 'per_unit', 'operation', 120, false),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 2.55, 'm', 'per_unit', 'material', 306, true),
    ('269', 'Mosadzné krúžky 25mm', 2, 'ks', 'per_unit', 'material', 240, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.008167, 'l', 'per_unit', 'material', 0.98, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 9, 'm', 'per_unit', 'material', 1080, true),
    ('311', 'Uv potlač Echobarrier HT 3,5', 1, 'ks', 'per_unit', 'intermediate', 120, false),
    ('3601', 'Mehler Plastel TE 8800-606', 9.5, 'm2', 'per_unit', 'material', 1140, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 16, 'ks', 'per_unit', 'material', 1920, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000750' and o.source_doc = 'DLE26080008'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000800', 'Výroba Echo Barrier Noise Defender (1250 x 2050 mm)', 'DLE25000006', '2025-01-14', 'PO-00001102', 140, 9, null, null, array['this note carries 2 products and one set of packaging lines; per-pallet rates are apportioned by batch share (0.400) and are ESTIMATES','pallet size not derivable: packaging shared between products']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 9, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 54, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 144, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 90, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 180, true),
    ('000308', 'Šitie', 10, 'min', 'per_unit', 'operation', 1400, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 560, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 35, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 560, false),
    ('000340', 'UV tlač + manipulácia', 2.571429, 'min', 'per_unit', 'operation', 360, false),
    ('000457', 'Grafika - súbory pre tlač', 0.107143, 'min', 'per_unit', 'operation', 15, false),
    ('2205', 'Reflexná páska heat transfer silver PU 50mm', 1, 'm', 'per_unit', 'material', 140, true),
    ('266', 'Pozinkované krúžky 25mm', 12, 'ks', 'per_unit', 'material', 1680, false),
    ('2756', 'AGFA ANUVIA 1550 RTR 2x1L CYAN', 0.000429, 'l', 'per_unit', 'material', 0.06, false),
    ('2759', 'AGFA ANUVIA 1550 RTR 2x1L BLACK', 0.000214, 'l', 'per_unit', 'material', 0.03, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 700, true),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 58, 'm', 'per_unit', 'material', 8120, true),
    ('311', 'Uv potlač Echobarrier RS-200', 1, 'ks', 'per_unit', 'intermediate', 140, false),
    ('3977', 'AGFA Anuvia 1051 RTR 4,5 L WHITE', 0.000929, 'l', 'per_unit', 'material', 0.13, false),
    ('4098', 'AGFA ANUVIA 1550 Y 1x5L', 0, 'l', 'per_unit', 'material', 0, false),
    ('4099', 'AGFA ANUVIA 1550 M 1x5L', 0.000143, 'l', 'per_unit', 'material', 0.02, false),
    ('827', 'Mehler 8540 - 543 polymar sidecurtain CL II lesklá', 3.1, 'm2', 'per_unit', 'material', 434, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000800' and o.source_doc = 'DLE25000006'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000760', 'Výroba Echo Barrier Noise Defender (3650 x 2050 mm)', 'DLE25000006', '2025-01-14', 'PO-00001102', 210, 9, null, null, array['this note carries 2 products and one set of packaging lines; per-pallet rates are apportioned by batch share (0.600) and are ESTIMATES','pallet size not derivable: packaging shared between products']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 9, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 9, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 54, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 144, false),
    ('378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', 90, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 180, true),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 840, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 52.5, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 840, false),
    ('000340', 'UV tlač + manipulácia', 4.857143, 'min', 'per_unit', 'operation', 1020, false),
    ('000406', 'Zváranie VF-SPIDER XYZ', 32, 'min', 'per_unit', 'operation', 6720, false),
    ('000457', 'Grafika - súbory pre tlač', 0.071429, 'min', 'per_unit', 'operation', 15, false),
    ('2205', 'Reflexná páska heat transfer silver PU 50mm', 1, 'm', 'per_unit', 'material', 210, true),
    ('266', 'Pozinkované krúžky 25mm', 18, 'ks', 'per_unit', 'material', 3780, false),
    ('2756', 'AGFA ANUVIA 1550 RTR 2x1L CYAN', 0.000333, 'l', 'per_unit', 'material', 0.07, false),
    ('2759', 'AGFA ANUVIA 1550 RTR 2x1L BLACK', 0.000381, 'l', 'per_unit', 'material', 0.08, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 1050, true),
    ('311', 'Uv potlač Echobarrier RT-100', 1, 'ks', 'per_unit', 'intermediate', 210, false),
    ('4098', 'AGFA ANUVIA 1550 Y 1x5L', 0.000143, 'l', 'per_unit', 'material', 0.03, false),
    ('4099', 'AGFA ANUVIA 1550 M 1x5L', 0.000238, 'l', 'per_unit', 'material', 0.05, false),
    ('984', 'Mehler Plastel TE 62 8800-705', 9.3, 'm2', 'per_unit', 'material', 1953, false)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000760' and o.source_doc = 'DLE25000006'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000760', 'Výroba Echo Barrier Noise Defender (3650 x 2050 mm)', 'DLE26080003', '2026-08-06', 'PO-00001377', 60, 2, 30, 59, array['pallet size is only pinned to 30..59 by this note']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', 2, true),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', 100, true),
    ('30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', 2, false),
    ('30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', 2, false),
    ('361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', 12, true),
    ('371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', 32, false),
    ('382', 'KAROS. PODLOŽKA ZI 6X30', 10, 'ks', 'per_pallet', 'material', 20, false),
    ('4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', 40, true),
    ('000309', 'Balenie', 5, 'min', 'per_unit', 'operation', 300, false),
    ('000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', 15, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 240, false),
    ('000340', 'UV tlač + manipulácia', 4, 'min', 'per_unit', 'operation', 240, false),
    ('000457', 'Grafika - súbory pre tlač', 0.25, 'min', 'per_unit', 'operation', 15, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 28, 'min', 'per_unit', 'operation', 1680, false),
    ('000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', 150, false),
    ('000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', 150, false),
    ('000852', 'Zváranie Echobarrier VF ND RT100', 1, 'ks', 'per_unit', 'operation', 60, false),
    ('2205', 'Reflexná páska heat transfer silver PU 50mm', 1, 'm', 'per_unit', 'material', 60, true),
    ('266', 'Pozinkované krúžky 25mm', 2, 'ks', 'per_unit', 'material', 120, false),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.001167, 'l', 'per_unit', 'material', 0.07, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', 300, true),
    ('311', 'Uv potlač Echobarrier ND RT 100', 1, 'ks', 'per_unit', 'intermediate', 60, false),
    ('4973', 'Mehler 8954 - 729, sivá', 9.5, 'm2', 'per_unit', 'material', 570, true),
    ('5', 'Pozinkované krúžky 25mm automatické', 16, 'ks', 'per_unit', 'material', 960, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000760' and o.source_doc = 'DLE26080003'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000805', 'Výroba Echo Barrier PB3 X (3150 x 1400 mm)', 'DLE25060001', '2025-06-04', 'PO-00001164', 3, null, null, null, array['no packing-bag line, so no pallet count and no per-pallet rates']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 15, 'min', 'per_unit', 'operation', 45, false),
    ('000309', 'Balenie', 4, 'min', 'per_unit', 'operation', 12, false),
    ('000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', 12, false),
    ('000340', 'UV tlač + manipulácia', 10, 'min', 'per_unit', 'operation', 30, false),
    ('000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 27, 'min', 'per_unit', 'operation', 81, false),
    ('000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', 7.5, false),
    ('000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', 7.5, false),
    ('000852', 'Zváranie Echobarrier VF PB3X', 1, 'ks', 'per_unit', 'operation', 3, false),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 30, 'm', 'per_unit', 'material', 90, true),
    ('2205', 'Reflexná páska heat transfer silver PU 50mm', 2, 'm', 'per_unit', 'material', 6, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.01, 'l', 'per_unit', 'material', 0.03, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 12.5, 'm', 'per_unit', 'material', 37.5, true),
    ('311', 'Uv potlač Echobarrier PB3X', 1, 'ks', 'per_unit', 'intermediate', 3, false),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 10, 'm', 'per_unit', 'material', 30, true),
    ('7', 'Mosadzné krúžky 25mm - automatické', 11, 'ks', 'per_unit', 'material', 33, true),
    ('77', 'Mehler 8205- 244 oranžová', 16, 'm2', 'per_unit', 'material', 48, false)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000805' and o.source_doc = 'DLE25060001'
on conflict (observation_id, component_code, basis) do nothing;

insert into public.mrp_bom_observation
  (fg_code, fg_label, source_doc, source_date, source_po, batch_size, pallet_count, pallet_size_min, pallet_size_max, warnings)
values ('000782', 'Výroba Echo Barrier V1 (2450 x 1950mm)', 'DLE26030004', '2026-03-04', 'PO-00001298', 12, null, null, null, array['no packing-bag line, so no pallet count and no per-pallet rates']::text[])
on conflict (fg_code, source_doc) do nothing;
insert into public.mrp_bom_observation_line
  (observation_id, component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
select o.id, v.* from public.mrp_bom_observation o, (values
    ('000308', 'Šitie', 115, 'min', 'per_unit', 'operation', 1380, false),
    ('000340', 'UV tlač + manipulácia', 6.25, 'min', 'per_unit', 'operation', 75, false),
    ('000406', 'Zváranie VF-SPIDER XYZ', 20, 'min', 'per_unit', 'operation', 240, false),
    ('000457', 'Grafika - súbory pre tlač', 2.5, 'min', 'per_unit', 'operation', 30, false),
    ('000651', 'Cutter- rez', 12, 'min', 'per_unit', 'operation', 144, false),
    ('000657', 'EuroLaser - rez', 3.5, 'min', 'per_unit', 'operation', 42, false),
    ('1566', 'Suchý zips 10 cm čierny háčik 102', 5.5, 'm', 'per_unit', 'material', 66, true),
    ('1567', 'Suchý zips 10 cm čierny vlas 102', 5.5, 'm', 'per_unit', 'material', 66, true),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 160, 'm', 'per_unit', 'material', 1920, true),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm', 4, 'm', 'per_unit', 'material', 48, true),
    ('2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.013333, 'l', 'per_unit', 'material', 0.16, false),
    ('2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.4, 'm2', 'per_unit', 'material', 4.8, false),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3.6, 'm', 'per_unit', 'material', 43.2, true),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000', 110, 'm', 'per_unit', 'material', 1320, true),
    ('311', 'Uv potlač Echobarrier V1', 1, 'ks', 'per_unit', 'intermediate', 12, false),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 5.5, 'm2', 'per_unit', 'material', 66, true),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40', 17, 'm', 'per_unit', 'material', 204, true),
    ('610', 'Suchý zips 50 mm, čierny- vlas', 0.5, 'm', 'per_unit', 'material', 6, true),
    ('611', 'Suchý zips 50 mm, čierny- háčik', 0.5, 'm', 'per_unit', 'material', 6, true)
  ) as v(component_code, component_desc, qty, unit, basis, line_type, raw_qty, in_stock_feed)
where o.fg_code = '000782' and o.source_doc = 'DLE26030004'
on conflict (observation_id, component_code, basis) do nothing;

-- ============================================================ 13 new products
-- Inert until a Hub SKU is mapped to them in mrp_bom_sku_map, which is Juraj's
-- call to make, not a migration's.

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000722', 'Výroba Echo Barrier CSC (komplet stan)', 2, 'DLE26070002', '2026-07-02', 2, 'PO-00001380', 'Derived from DLE26070002 (2026-07-02), batch 2. pallet size at least 2, only one pallet was filled. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000722', 1, '311', 'Uv potlač Echobarrier CSC s logom CIVILS', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 2, '1566', 'Suchý zips 10 cm čierny háčik 102', 11, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 3, '1567', 'Suchý zips 10 cm čierny vlas 102', 35.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 4, '1972', 'PVC mäkčené pásy Standart 2/200mm', 9.6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 5, '1973', 'PVC mäkčené pásy Standart 3/300mm', 16, 'm', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 6, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 270, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 7, '2204', 'Reflexná páska heat transfer silver PU 25mm', 6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 8, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.4, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 9, '2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 1.2, 'm2', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 10, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 4, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 11, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 395, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 12, '478', 'Západkový uzáver', 2, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 13, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 40, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 14, '548', 'Pás PVC navarovaci šírky 48mm čierny', 4.5, 'm', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 15, '605', 'Lemovka- Popruh PP 31S900 10/1/25', 2, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 16, '606', 'Lemovka Popruh PP 31S900 10/1/40', 73, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 17, '611', 'Suchý zips 50 mm, čierny- háčik', 12.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 18, '000340', 'UV tlač + manipulácia', 15, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 19, '000406', 'Zváranie VF-SPIDER XYZ', 0, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 20, '000457', 'Grafika - súbory pre tlač', 45, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 21, '000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 210, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 22, '000651', 'Cutter- rez', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 23, '000657', 'EuroLaser - rez', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 24, '000852', 'Zváranie Echobarrier VF', 1, 'ks', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 25, '356', 'zváranie strechy + lamepy', 90, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 26, '2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 27, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26070002'),
  ('000722', 28, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26070002')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000723', 'Výroba Echo Barrier CS R10 (komplet stan)', 5, 'DLE26070001', '2026-07-02', 10, 'PO-00001376', 'Derived from DLE26070001 (2026-07-02), batch 10. pallet size pinned to 5..9 by this note; the minimum is used, which over-states packaging demand rather than under-stating it. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000723', 1, '311', 'Uv potlač Echobarrier R10', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 2, '1566', 'Suchý zips 10 cm čierny háčik 102', 25, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 3, '1567', 'Suchý zips 10 cm čierny vlas 102', 45, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 4, '1972', 'PVC mäkčené pásy Standart 2/200mm', 9.6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 5, '1973', 'PVC mäkčené pásy Standart 3/300mm', 16, 'm', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 6, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 410, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 7, '2204', 'Reflexná páska heat transfer silver PU 25mm', 6.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 8, '263', 'Pozinkované krúžky 10mm', 4, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 9, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.05, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 10, '2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.9, 'm2', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 11, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 17.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 12, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 517, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 13, '478', 'Západkový uzáver', 2, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 14, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 52.5, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 15, '548', 'Pás PVC navarovaci šírky 48mm čierny', 4, 'm', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 16, '605', 'Lemovka- Popruh PP 31S900 10/1/25', 2.6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 17, '606', 'Lemovka Popruh PP 31S900 10/1/40', 107, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 18, '611', 'Suchý zips 50 mm, čierny- háčik', 20, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 19, '000340', 'UV tlač + manipulácia', 16, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 20, '000457', 'Grafika - súbory pre tlač', 3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 21, '000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 210, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 22, '000651', 'Cutter- rez', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 23, '000657', 'EuroLaser - rez', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 24, '000852', 'Zváranie Echobarrier VF R10', 1, 'ks', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 25, '356', 'zváranie lamiel + strecha', 120, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 26, '2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 27, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26070001'),
  ('000723', 28, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26070001')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000975', 'Výroba Echo Barrier Gen set extension (752 x 3983,7 mm)', null, 'DLE26050003', '2026-05-12', 100, 'PO-00001327', 'Derived from DLE26050003 (2026-05-12), batch 100. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000975', 1, '311', 'Uv potlač Echobarrier Gen set extension', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 50, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 3, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0072, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 4, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 5, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 3.65, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 6, '606', 'Lemovka Popruh PP 31S900 10/1/40', 10, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 7, '7', 'Mosadzné krúžky 25mm - automatické', 31, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 8, '000289', 'Práca - šitie', 30, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 9, '000309', 'Balenie', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 10, '000328', 'Práca- Vybitie krúžkov', 12, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 11, '000340', 'UV tlač + manipulácia', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 12, '000457', 'Grafika - súbory pre tlač', 0.3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 13, '000651', 'Cutter- rez', 3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003'),
  ('000975', 14, '000657', 'EuroLaser - rez', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26050003')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('30049', 'Výroba Echo Barrier Gen set M1', 10, 'DLE26030003', '2026-03-04', 10, 'PO-00001290', 'Derived from DLE26030003 (2026-03-04), batch 10. pallet size at least 10, only one pallet was filled. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('30049', 1, '311', 'Uv potlač Echobarrier Gen set M1', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 2, '1566', 'Suchý zips 10 cm čierny háčik 102', 20, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 3, '1567', 'Suchý zips 10 cm čierny vlas 102', 12, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 4, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 227, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 5, '2204', 'Reflexná páska heat transfer silver PU 25mm', 3, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 6, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.007, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 7, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 187, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 8, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 15, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 9, '606', 'Lemovka Popruh PP 31S900 10/1/40', 40, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 10, '900', 'Serge Ferrari meshes 362- 50201 zelená', 15, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 11, '000289', 'Práca - šitie', 260, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 12, '000340', 'UV tlač + manipulácia', 3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 13, '000457', 'Grafika - súbory pre tlač', 3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 14, '000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 15, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 16, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 17, '000852', 'Zváranie Echobarrier VF GEN set M1', 1, 'ks', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 18, '1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 19, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 20, '30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 21, '361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 22, '371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 23, '376', 'KAROS. PODLOŽKA ZI 5X20', 10.5, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26030003'),
  ('30049', 24, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26030003')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000762', 'Výroba Echo Barrier H10 s prackou+ navarovacia reflexná páska (1335 x 2050 mm)', 65, 'DLE26080007', '2026-08-18', 520, 'PO-00001397', 'Derived from DLE26080007 (2026-08-18), batch 520. pallet size pinned to 65..74 by this note; the minimum is used, which over-states packaging demand rather than under-stating it. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000762', 1, '311', 'Uv potlač Echobarrier H 10', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 4, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0075, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 5, '2926', 'SQP, UV - Ink 5L ( Farby Nyala )', 0.000769, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 6, '300', 'Plastová podložka pod nity A-25/35.25', 1, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 7, '301', 'Plastová podložka pod nity 35.51', 2, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 8, '303', 'Nit zaklepavaci', 4, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 9, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 10, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 0.22, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 11, '4376', 'SQA, Primer 1 liter', 0.000192, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 12, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 13, '605', 'Lemovka- Popruh PP 31S900 10/1/25', 0.7, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 14, '606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 15, '621', 'FS 25 NY Pracka čierna 25 mm', 1, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 16, '7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 17, '897', 'Sieťka 362- zelená (2050x1335 mm)', 1, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 18, '000308', 'Šitie', 10, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 19, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 20, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 21, '000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 22, '000340', 'UV tlač + manipulácia', 1.846154, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 23, '000457', 'Grafika - súbory pre tlač', 0.028846, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 24, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 25, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 26, '000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 27, '000714', 'Vybitie pracky', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 28, '1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 29, '2192', 'Nctech nitka 34 farba čierna 4000, 1500bm', 50, 'm', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 30, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 31, '30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 32, '361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 33, '371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 34, '378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26080007'),
  ('000762', 35, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26080007')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000957', 'Výroba Echo Barrier H2 (1335 x 2050 mm)', null, 'DLE26070011', '2026-07-30', 2, 'PO-00001411', 'Derived from DLE26070011 (2026-07-30), batch 2. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000957', 1, '311', 'Uv potlač Echobarrier H2', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 39, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 4, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.01, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 5, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 6, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 2.85, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 7, '606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 8, '7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 9, '900', 'Serge Ferrari meshes 362- 50201 zelená', 2.85, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 10, '000308', 'Šitie', 10, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 11, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 12, '000340', 'UV tlač + manipulácia', 0, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 13, '000457', 'Grafika - súbory pre tlač', 5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 14, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 15, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 16, '000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011'),
  ('000957', 17, '000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26070011')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000751', 'Výroba Echo Barrier H9 mini (1010 x 658 mm)', null, 'DLE25020008', '2025-02-25', 180, 'PO-00001089', 'Derived from DLE25020008 (2025-02-25), batch 180. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000751', 1, '311', 'Uv potlač Echobarrier H9mini', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 9.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 1, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 4, '264', 'Pozinkované krúžky 12mm', 19, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 5, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.001611, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 6, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 2, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 7, '606', 'Lemovka Popruh PP 31S900 10/1/40', 3.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 8, '903', 'H5673 - 6026-1 (zelená)', 0.85, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 9, '000308', 'Šitie', 7, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 10, '000309', 'Balenie', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 11, '000326', 'Rezanie reflexnej pásky', 0.15, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 12, '000328', 'Práca- Vybitie krúžkov', 8, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 13, '000340', 'UV tlač + manipulácia', 0.75, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 14, '000457', 'Grafika - súbory pre tlač', 0.083333, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 15, '000651', 'Cutter- rez', 1, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 16, '000657', 'EuroLaser - rez', 1, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 17, '000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('000751', 18, '000713', 'Lepenie bavlny', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000967', 'Výroba Echo Barrier H9J (1270x1030 mm)', null, 'DLE26020004', '2026-02-11', 1, 'PO-00001293', 'Derived from DLE26020004 (2026-02-11), batch 1. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000967', 1, '311', 'Uv potlač Echobarrier H9J', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 2, '1621', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 15, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 0.75, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 4, '2926', 'SQP, UV - Ink 5L ( Farby Nyala )', 0.01, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 5, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3.85, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 6, '606', 'Lemovka Popruh PP 31S900 10/1/40', 4.8, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 7, '7', 'Mosadzné krúžky 25mm - automatické', 15, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 8, '827', 'Mehler 8540 - 543 polymar sidecurtain CL II lesklá', 1.42, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 9, '000308', 'Šitie', 5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 10, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 11, '000328', 'Práca- Vybitie krúžkov', 3, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 12, '000340', 'UV tlač + manipulácia', 15, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 13, '000457', 'Grafika - súbory pre tlač', 30, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 14, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 15, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 16, '000664', 'Zváranie VF-ZEMAT', 1, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004'),
  ('000967', 17, '000713', 'Lepenie bavlny', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020004')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('30050', 'Výroba Echo Barrier H9W', null, 'DLE25020008', '2025-02-25', 70, 'PO-00001089', 'Derived from DLE25020008 (2025-02-25), batch 70. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('30050', 1, '311', 'Uv potlač Echobarrier H9W', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 40, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 1.71, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 4, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.007429, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 5, '2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.5, 'm2', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 6, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 7, '606', 'Lemovka Popruh PP 31S900 10/1/40', 7, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 8, '7', 'Mosadzné krúžky 25mm - automatické', 19, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 9, '903', 'H5673 - 6026-1 (zelená)', 3, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 10, '000308', 'Šitie', 10, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 11, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 12, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 13, '000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 14, '000340', 'UV tlač + manipulácia', 2.571429, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 15, '000457', 'Grafika - súbory pre tlač', 0.214286, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 16, '000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 17, '000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 18, '000664', 'Zváranie VF-ZEMAT', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 19, '000713', 'Lepenie bavlny', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008'),
  ('30050', 20, '000852', 'Zváranie Echobarrier H9W', 1, 'ks', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25020008')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000726', 'Výroba Echo Barrier H9X (1335 x 2550 mm)', 50, 'DLE26020003', '2026-02-10', 400, 'PO-00001280', 'Derived from DLE26020003 (2026-02-10), batch 400. pallet size pinned to 50..57 by this note; the minimum is used, which over-states packaging demand rather than under-stating it. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000726', 1, '311', 'Uv potlač Echobarrier H9x', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 14.8175, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 3, '2204', 'Reflexná páska heat transfer silver PU 25mm', 2, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 4, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.0075, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 5, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 7, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 6, '4713', 'Magnet KV-30-20-05-N', 2, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 7, '50', 'Sioline B6148- 6444 (zelená) 900g 2,67 x 54 m', 0.9, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 8, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 3.6, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 9, '606', 'Lemovka Popruh PP 31S900 10/1/40', 8, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 10, '662', 'Račna s pásom 50mm + račnový pás komplet', 0.025, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 11, '7', 'Mosadzné krúžky 25mm - automatické', 23, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 12, '000308', 'Šitie', 30, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 13, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 14, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 15, '000328', 'Práca- Vybitie krúžkov', 5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 16, '000340', 'UV tlač + manipulácia', 2.375, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 17, '000457', 'Grafika - súbory pre tlač', 0.075, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 18, '000651', 'Cutter- rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 19, '000657', 'EuroLaser - rez', 2, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 20, '356', 'rez bavlna', 1.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 21, '1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 22, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 23, '30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 24, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 50, 'm', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 25, '361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 26, '371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 27, '378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE26020003'),
  ('000726', 28, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE26020003')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000800', 'Výroba Echo Barrier Noise Defender (1250 x 2050 mm)', null, 'DLE25000006', '2025-01-14', 140, 'PO-00001102', 'Derived from DLE25000006 (2025-01-14), batch 140. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000800', 1, '311', 'Uv potlač Echobarrier RS-200', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 2, '2205', 'Reflexná páska heat transfer silver PU 50mm', 1, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 3, '266', 'Pozinkované krúžky 25mm', 12, 'ks', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 4, '2756', 'AGFA ANUVIA 1550 RTR 2x1L CYAN', 0.000429, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 5, '2759', 'AGFA ANUVIA 1550 RTR 2x1L BLACK', 0.000214, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 6, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 7, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 58, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 8, '3977', 'AGFA Anuvia 1051 RTR 4,5 L WHITE', 0.000929, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 9, '4098', 'AGFA ANUVIA 1550 Y 1x5L', 0, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 10, '4099', 'AGFA ANUVIA 1550 M 1x5L', 0.000143, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 11, '827', 'Mehler 8540 - 543 polymar sidecurtain CL II lesklá', 3.1, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 12, '000308', 'Šitie', 10, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 13, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 14, '000326', 'Rezanie reflexnej pásky', 0.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 15, '000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 16, '000340', 'UV tlač + manipulácia', 2.571429, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 17, '000457', 'Grafika - súbory pre tlač', 0.107143, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 18, '1781', 'Kovové istenie', 1, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 19, '30040', 'Vak na balenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 20, '30045', 'Kovové zaistenie', 1, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 21, '361', 'Texa do železa 4,8X25', 6, 'ks', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 22, '371', 'SKR. do dreva žlta 5 X 50', 16, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 23, '378', 'KAROS. PODLOŽKA ZI 5X30', 10, 'ks', 'per_pallet', 'material', false, false, 'delivery_note_estimate', 'DLE25000006'),
  ('000800', 24, '4898', 'TK.PE 753 modrý kašír', 20, 'm2', 'per_pallet', 'material', true, false, 'delivery_note_estimate', 'DLE25000006')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000805', 'Výroba Echo Barrier PB3 X (3150 x 1400 mm)', null, 'DLE25060001', '2025-06-04', 3, 'PO-00001164', 'Derived from DLE25060001 (2025-06-04), batch 3. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000805', 1, '311', 'Uv potlač Echobarrier PB3X', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 2, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 30, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 3, '2205', 'Reflexná páska heat transfer silver PU 50mm', 2, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 4, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.01, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 5, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 12.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 6, '606', 'Lemovka Popruh PP 31S900 10/1/40', 10, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 7, '7', 'Mosadzné krúžky 25mm - automatické', 11, 'ks', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 8, '77', 'Mehler 8205- 244 oranžová', 16, 'm2', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 9, '000308', 'Šitie', 15, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 10, '000309', 'Balenie', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 11, '000328', 'Práca- Vybitie krúžkov', 4, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 12, '000340', 'UV tlač + manipulácia', 10, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 13, '000582', 'Zváranie vysoko frekvenciou SPIDER XYZ', 27, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 14, '000651', 'Cutter- rez', 2.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 15, '000657', 'EuroLaser - rez', 2.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001'),
  ('000805', 16, '000852', 'Zváranie Echobarrier VF PB3X', 1, 'ks', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE25060001')
on conflict (fg_code, component_code, basis) do nothing;

insert into public.mrp_bom_product (fg_code, fg_label, pallet_size, source_doc, source_date, source_batch, source_po, notes)
values ('000782', 'Výroba Echo Barrier V1 (2450 x 1950mm)', null, 'DLE26030004', '2026-03-04', 12, 'PO-00001298', 'Derived from DLE26030004 (2026-03-04), batch 12. no packing-bag line on this note, so no pallet size and no per-pallet demand. Transcribed line by line and independently re-read. Estimate, not an official bill of materials.')
on conflict (fg_code) do nothing;
insert into public.mrp_bom_component
  (fg_code, line_no, component_code, component_desc, qty, unit, basis, line_type, is_gating, verified, source_kind, source_doc)
values
  ('000782', 1, '311', 'Uv potlač Echobarrier V1', 1, 'ks', 'per_unit', 'intermediate', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 2, '1566', 'Suchý zips 10 cm čierny háčik 102', 5.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 3, '1567', 'Suchý zips 10 cm čierny vlas 102', 5.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 4, '2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm', 160, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 5, '2204', 'Reflexná páska heat transfer silver PU 25mm', 4, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 6, '2919', 'AGFA ANUVIA 5L ( Farby Tauro )', 0.013333, 'l', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 7, '2931', 'Achilles PVC 1,37x50 bm, 0,5 mm B1- nehorľavá', 0.4, 'm2', 'per_unit', 'material', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 8, '3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m', 3.6, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 9, '3097', 'Nctech nitka 20 farba čierna 3713-4000', 110, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 10, '5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm', 5.5, 'm2', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 11, '606', 'Lemovka Popruh PP 31S900 10/1/40', 17, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 12, '610', 'Suchý zips 50 mm, čierny- vlas', 0.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 13, '611', 'Suchý zips 50 mm, čierny- háčik', 0.5, 'm', 'per_unit', 'material', true, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 14, '000308', 'Šitie', 115, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 15, '000340', 'UV tlač + manipulácia', 6.25, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 16, '000406', 'Zváranie VF-SPIDER XYZ', 20, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 17, '000457', 'Grafika - súbory pre tlač', 2.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 18, '000651', 'Cutter- rez', 12, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004'),
  ('000782', 19, '000657', 'EuroLaser - rez', 3.5, 'min', 'per_unit', 'operation', false, false, 'delivery_note_estimate', 'DLE26030004')
on conflict (fg_code, component_code, basis) do nothing;
