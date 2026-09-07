-- Bamida's facade API now returns `ns_number` — the ONIX item code printed as
-- "Kod polozky" on every Bamida delivery note. That makes it the real identity
-- of a material card, and the join key from a manufacturing BOM to live stock.
-- Until now rows were keyed on trimmed `item_name`, because the facade's `sku`
-- field is a broken constant ('SK' for all 112 cards). Names are Slovak free
-- text with inconsistent internal spacing; one re-typing at Bamida's end would
-- have created a duplicate card and silently split an item's history.
--
-- This lands ns_number as the natural key but deliberately does NOT drop the
-- item_name unique constraint: the live 06:00 sync still upserts
-- on_conflict=item_name and PostgREST needs that constraint to exist. It is
-- dropped in a follow-up migration once the sync has been switched to
-- on_conflict=ns_number and proven by a real run.

alter table public.bamida_material_stock
  add column if not exists ns_number text;

alter table public.bamida_material_stock_history
  add column if not exists ns_number text;

-- Point-in-time backfill: the 112 cards returned by the feed at the 2026-08-08
-- 05:00 sync, which is exactly the set of rows currently in the table
-- (112 total / 112 active, all last_synced_at = that run).
with feed_snapshot(ns_number, item_name) as (
  values
    ('5', 'Pozinkované krúžky 25mm automatické'),
    ('7', 'Mosadzné krúžky 25mm - automatické'),
    ('28', 'Sioline B8103 - 6001 (zelená)  650g  2,5 x 65 m'),
    ('37', 'PES 560D 64T - olivová  1,47 x 40 m'),
    ('50', 'Sioline B6148- 6444 (zelená)  900g  2,67 x 54 m'),
    ('269', 'Mosadzné krúžky 25mm'),
    ('300', 'Plastová podložka pod nity A-25/35.25'),
    ('301', 'Plastová podložka pod nity 35.51'),
    ('361', 'Texa  do  železa  4,8X25'),
    ('418', 'Suchý zips 50 mm, biely- háčik'),
    ('419', 'Suchý zips 50 mm, biely- vlas'),
    ('420', 'Suchý zips 38 mm, čierny- háčik'),
    ('421', 'Suchý zips 38 mm, čierny- vlas'),
    ('422', 'Suchý zips 25 mm, čierny- vlas'),
    ('423', 'Suchý zips 25 mm, čierny- háčik'),
    ('605', 'Lemovka- Popruh PP 31S900 10/1/25'),
    ('606', 'Lemovka Popruh PP 31S900 10/1/40'),
    ('607', 'Suchý zips 38 mm, biely- vlas'),
    ('608', 'Suchý zips 38 mm, biely- háčik'),
    ('610', 'Suchý zips 50 mm, čierny- vlas'),
    ('611', 'Suchý zips 50 mm, čierny- háčik'),
    ('621', 'FS 25 NY  Pracka čierna 25 mm'),
    ('679', 'TESA - Obojstranná lepiaca páska 50mmx25m/50m'),
    ('810', 'Molitan 5cm'),
    ('817', 'Mehrel  8540 - 907  VS 900 FR biela'),
    ('818', 'Mehler 8540 VS 900 FR RAL 5002 ,modrá  matná, šírka 267cm'),
    ('824', 'Mehler  8540 VS 900 FR RAL 370,červená'),
    ('827', 'Mehler  8540 - 543 polymar sidecurtain CL II lesklá'),
    ('877', 'H5673- 9005 (čierna)'),
    ('897', 'Sieťka  362- zelená (2050x1335 mm)'),
    ('899', 'Serge Ferrari meshes 362- 1075 čierna'),
    ('900', 'Serge Ferrari meshes 362- 50201 zelená'),
    ('903', 'H5673 - 6026-1 (zelená)'),
    ('914', 'Dvojbrzda plastová'),
    ('929', 'Mehler L&B 8540 VS 900 FR RAL543, modrá matná'),
    ('961', 'Lemovací pás 40 mm biela'),
    ('1274', 'Výstuhy'),
    ('1303', 'Plastel TE 62 8800-119'),
    ('1424', 'Mehler  8509-636 zelena'),
    ('1437', 'Suchý zips 25 mm, biely- háčik'),
    ('1450', 'Akustická pena S 000-040 600/600/40'),
    ('1490', 'Oracal 6510 Fluorescentná red orange 1,26x50m'),
    ('1509', 'Valmex Torabdichtung 2mm  2,1m'),
    ('1513', 'Podlahová guma  šírka 1,2 m Hr.3mm'),
    ('1519', 'Oceľová karabína KRATOS'),
    ('1520', 'Reťaz poisťovací 10x150 cm'),
    ('1565', 'Mehler Plastel 8948 905 čierna'),
    ('1566', 'Suchý zips 10 cm čierny háčik 102'),
    ('1567', 'Suchý zips 10 cm čierny vlas 102'),
    ('1621', 'Nitka Nctech 34 farba biela 1000, 1500bm 3712-1000'),
    ('1689', 'Mehler 8212-123 béžová  650g'),
    ('1733', 'Špirálová metráž No 10 čierna ZIPS'),
    ('1761', 'Lemovací pás 25 mm biely'),
    ('1781', 'Kovové istenie'),
    ('1972', 'PVC mäkčené pásy Standart 2/200mm'),
    ('1991', 'Špirálová metráž No 10 biela ZIPS'),
    ('2052', 'Mehler  8540-636 polymar sidecurtian CL II'),
    ('2189', 'Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm'),
    ('2192', 'Nctech nitka 34 farba čierna 4000, 1500bm'),
    ('2204', 'Reflexná páska heat transfer silver PU 25mm'),
    ('2205', 'Reflexná páska heat transfer silver PU 50mm'),
    ('2246', 'Protihlukový plot'),
    ('2593', 'Odevná šnúra'),
    ('2665', 'Lemovka- Popruh PP 25 mm béžová'),
    ('2680', 'Sioline B6148- 5488 (modrá)  900g  2,67 x 54 m'),
    ('2683', 'Špirálová metráž NO 5 mm hnedá ZIPS'),
    ('2684', 'Bežec No5 autolok Nikel'),
    ('2685', 'Špirálová metráž NO 5 mm biela ZIPS'),
    ('2686', 'Špirálová metráž NO 5 mm čierna ZIPS'),
    ('2754', 'Sieťka 362- 50201 zelená 1320mm - mesh'),
    ('2846', 'Konštrukčná klietka'),
    ('2865', 'Pracka opasková posúvač 40348 40'),
    ('2909', 'Tričko CXS EMILY, dámske'),
    ('2910', 'Mikina CXS GRANBY LADY, dámska'),
    ('2963', 'PVC poškodená'),
    ('2964', 'MESH poškodený'),
    ('3058', 'Zips UH7 630cm'),
    ('3076', 'LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m'),
    ('3097', 'Nctech nitka 20 farba čierna 3713-4000'),
    ('3152', 'Duplocoll 919'),
    ('3162', 'Mehler Plastel TE 8800-729'),
    ('3188', 'Mehler  8509-905'),
    ('3233', 'Mehler L&B 8212-581 Valmex FR'),
    ('3313', 'Špirálová metráž No 8 čierna ZIPS YKK'),
    ('3503', 'TK.PE 760 modro-čierna'),
    ('3539', 'Guma hladká čierna  šírka 10 cm tkaná'),
    ('3601', 'Mehler Plastel TE 8800-606'),
    ('3608', 'TK.PE 700 modro-modra'),
    ('3653', 'Papsule keder PVC 4/10 oranžový'),
    ('3655', 'Vinytol 701 N'),
    ('3698', 'Suchý zips 10 cm biely háčik 102'),
    ('3699', 'Suchý zips 10 cm biely vlas 102'),
    ('3708', 'Kružková mechanika 272/15 A'),
    ('3711', 'Silver reflective tape FR 25 mm'),
    ('3725', 'PE vrecia-tenké'),
    ('3852', 'Silver reflective tape FR 50 mm'),
    ('3970', 'Molitan #1'),
    ('4007', 'Tepelná izolácia DAPE ABA parotesná 96 x 500 cm'),
    ('4430', 'Nctech nitka 20 farba Červená 0503  1000bm'),
    ('4505', 'Mehler Plastel TE 62 8800-907 biela'),
    ('4557', 'Lemovka Popruh PP 10/1/50 biely'),
    ('4564', 'PVC mäkčené pásy Standart 2/300mm namodrasta'),
    ('4713', 'Magnet KV-30-20-05-N'),
    ('4898', 'TK.PE 753 modrý kašír'),
    ('4973', 'Mehler 8954 - 729, sivá'),
    ('4991', 'Nitka Outdoor Pro 20 čierna'),
    ('5019', 'P1 frame'),
    ('5027', 'Vinytol 701/1209 sivá'),
    ('5028', 'Vinytol 701/8160 červená'),
    ('5029', 'Vinytol 701/6604 žltá'),
    ('5097', 'Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm'),
    ('5098', 'Mehler 8540 VS 900 FR RAL 905,čierna, šírka 267cm')
)
update public.bamida_material_stock s
   set ns_number = f.ns_number
  from feed_snapshot f
 where btrim(s.item_name) = f.item_name
   and s.ns_number is distinct from f.ns_number;

-- Carry the key back into history so burn-rate series survive a future rename.
-- Rows whose item has already left the feed stay null; that is expected, which
-- is why history keeps item_name as its own not-null column.
update public.bamida_material_stock_history h
   set ns_number = s.ns_number
  from public.bamida_material_stock s
 where btrim(h.item_name) = btrim(s.item_name)
   and h.ns_number is null;

-- Fail loudly rather than half-migrate: every live card must carry a key before
-- ns_number can take a NOT NULL / UNIQUE contract.
do $$
declare missing int;
begin
  select count(*) into missing
    from public.bamida_material_stock
   where is_active and ns_number is null;
  if missing > 0 then
    raise exception 'ns_number backfill incomplete: % active rows still null', missing;
  end if;
end $$;

alter table public.bamida_material_stock
  alter column ns_number set not null;

create unique index if not exists bamida_material_stock_ns_number_key
  on public.bamida_material_stock (ns_number);

create index if not exists bamida_material_stock_history_ns_time
  on public.bamida_material_stock_history (ns_number, captured_at desc);

comment on column public.bamida_material_stock.ns_number is
  'ONIX item code from the Bamida facade feed. THE natural key for a material card, and the value printed as "Kod polozky" on Bamida delivery notes — so it is the join key from a manufacturing BOM to live stock. Prefer this over item_name (Slovak free text, re-typeable) and over bamida_sku (facade bug: constant ''SK'').';

comment on column public.bamida_material_stock.item_name is
  'Slovak display name from the feed. Descriptive only — join on ns_number. Kept not-null for readability in Slack and board output.';

comment on column public.bamida_material_stock.available_quantity is
  'Feed value = quantity - reserved. NOT a usable availability signal: reservations accumulate and are never drained, so 10 of 112 cards read deeply negative (orange thread -165,717 m against 75,093 m physically on hand). Use `quantity` to answer "can this be built"; treat a negative here as an over-commitment warning, never as stock.';

comment on column public.bamida_material_stock_history.ns_number is
  'ONIX item code, backfilled by name join at migration time. Null for rows whose item had already left the feed. Series should be grouped on this, not item_name.';
