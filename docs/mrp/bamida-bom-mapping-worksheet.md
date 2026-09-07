# Bamida BOM mapping worksheet (for Kamil)

Generated 2026-08-07 from the latest mfg BOM snapshots (week 2026-07-27, 22 models)
and the live `bamida_material_stock` list (112 items). Backing table:
`mrp_bom_map` in the ops project (194 rows, 33 finished SKUs).

## Instructions

For each component in the table below, copy the exact **item name** from the
Appendix into the "Bamida item_name" column — character for character, Slovak
diacritics included, because the stock lookup matches on the exact text. If the
component is not a physical material Bamida keeps in stock (for example a fee,
transport line, or something supplied by Group), write **n/a** instead of
guessing. One suggestion is already pre-filled (ACI-T40) — please confirm or
correct it; no mapping is used by the Hub until it has been entered and marked
verified. Rows you mark **n/a** also get recorded as confirmed — meaning
"checked, and it is not a Bamida-stocked material" — so please answer every
row rather than leaving blanks.

### Pokyny (slovensky)

Pre každý komponent v tabuľke nižšie skopírujte presný názov položky
(item_name) z prílohy do stĺpca „Bamida item_name" — znak po znaku, vrátane
diakritiky, pretože vyhľadávanie skladu sa páruje na presný text. Ak komponent
nie je fyzický materiál, ktorý má Bamida na sklade (napríklad poplatok,
doprava alebo materiál dodávaný z Group), napíšte **n/a** — nehádajte. Jeden
návrh je už predvyplnený (ACI-T40) — prosím potvrďte ho alebo opravte; Hub
žiadne mapovanie nepoužije, kým nie je zapísané a označené ako overené.
Aj odpoveď **n/a** sa zaznamená ako potvrdená („skontrolované, nie je to
skladový materiál Bamidy"), preto prosím vyplňte každý riadok.

## Components to map

All distinct components across the 22 current BOMs. "Used in" counts models
(H9, H10HercBlack, CSCompact, ...), not SKUs.

| Component code | BOM description | Used in | Bamida item_name (fill in) |
|---|---|---|---|
| ACI-T35 | Accoustic Infill Senizol T35 | 3 models (H8, HT3.5, NDS200) | |
| ACI-T40 | Accoustic InfillSenizol T40 | 17 models (H9/H10/CS families, M1, V2, ...) | SUGGESTED: `Akustická pena S 000-040 600/600/40` — confirm? |
| ACI-TRNS | Transport Accoustic Infill | 20 models | |
| ACI-TRNS-OP | Transport Accoustic Infillopence.l | 2 models (HERAS, NDT) | |
| DAT-01 | Datatag | 19 models | |
| GRP-SLTF | Group Slitting Fee | 21 models | |
| N1830-18-1000 | N1830 16-18 kg/m3 TL 20 / 1000x1580 mm / or alternatively SK TEX | 2 models (HERAS, NDT) | |
| P200 | P200 | 4 models (H10, H10HercBlack, H10Japan, H8Mini) | |
| PC350FR-TRNS | Transport PC350FR | 22 models | |
| PC350FR-UV15 | PC350 FR UV 1.50 m wide roll | 1 model (H9X 1.5W) | |
| PC350FR-UV21 | PC350 FR UV 2.1 Wide | 17 models | |

## Appendix — Bamida stock items (`bamida_material_stock.item_name`)

Full list of the 112 stock items, with the available quantity at generation
time for recognition context (quantities change; only the name matters here).
Negative quantities are stock-ledger artifacts (uncleared issues/receipts in
the Bamida system) — ignore the sign; they do not mean anything for this
mapping exercise.

| # | item_name | available_quantity |
|---|---|---|
| 1 | Akustická pena S 000-040 600/600/40 | 0 |
| 2 | Bežec No5 autolok Nikel | 136 |
| 3 | Duplocoll 919 | 40 |
| 4 | Dvojbrzda plastová | 114 |
| 5 | FS 25 NY  Pracka čierna 25 mm | 94 |
| 6 | Guma hladká čierna  šírka 10 cm tkaná | 0 |
| 7 | H5673 - 6026-1 (zelená) | 6981.98 |
| 8 | H5673- 9005 (čierna) | 230.2 |
| 9 | Konštrukčná klietka | 0 |
| 10 | Kovové istenie | -104 |
| 11 | Kružková mechanika 272/15 A | 53 |
| 12 | Lemovací pás 25 mm biely | 0 |
| 13 | Lemovací pás 40 mm biela | 0 |
| 14 | Lemovka Popruh PP 10/1/50 biely | 0 |
| 15 | Lemovka Popruh PP 31S900 10/1/40 | -4770.4 |
| 16 | Lemovka- Popruh PP 25 mm béžová | 0 |
| 17 | Lemovka- Popruh PP 31S900 10/1/25 | 3623.55 |
| 18 | LOHMANN - Duplocoll 3702 obojstranná lepiaca páska 50mm x 50m | -10207.55 |
| 19 | Magnet KV-30-20-05-N | 16 |
| 20 | Mehler  8509-636 zelena | 2512.5 |
| 21 | Mehler  8509-905 | 0 |
| 22 | Mehler  8540 - 543 polymar sidecurtain CL II lesklá | 920.61 |
| 23 | Mehler  8540 VS 900 FR RAL 370,červená | 0 |
| 24 | Mehler  8540-636 polymar sidecurtian CL II | 0 |
| 25 | Mehler 8212-123 béžová  650g | 407 |
| 26 | Mehler 8540 VS 900 FR RAL 5002 ,modrá  matná, šírka 267cm | 4947.51 |
| 27 | Mehler 8540 VS 900 FR RAL 6026,zelená matná, šírka 267cm | 8800.58 |
| 28 | Mehler 8540 VS 900 FR RAL 905,čierna, šírka 267cm | 913.17 |
| 29 | Mehler 8954 - 729, sivá | 0 |
| 30 | Mehler L&B 8212-581 Valmex FR | 0 |
| 31 | Mehler L&B 8540 VS 900 FR RAL543, modrá matná | 0 |
| 32 | Mehler Plastel 8948 905 čierna | 4038.27 |
| 33 | Mehler Plastel TE 62 8800-907 biela | 0 |
| 34 | Mehler Plastel TE 8800-606 | -808.5 |
| 35 | Mehler Plastel TE 8800-729 | 0 |
| 36 | Mehrel  8540 - 907  VS 900 FR biela | 140 |
| 37 | MESH poškodený | 0 |
| 38 | Mikina CXS GRANBY LADY, dámska | 0 |
| 39 | Molitan #1 | -2.6 |
| 40 | Molitan 5cm | 0 |
| 41 | Mosadzné krúžky 25mm | 34354 |
| 42 | Mosadzné krúžky 25mm - automatické | -9456 |
| 43 | Nctech nitka 20 farba Červená 0503  1000bm | 72827 |
| 44 | Nctech nitka 20 farba čierna 3713-4000 | 18684.58 |
| 45 | Nctech nitka 20 farba ORANŽOVÁ 3516, 1000bm | -165717 |
| 46 | Nctech nitka 34 farba čierna 4000, 1500bm | 17025 |
| 47 | Nitka Nctech 34 farba biela 1000, 1500bm 3712-1000 | -140 |
| 48 | Nitka Outdoor Pro 20 čierna | 11598 |
| 49 | Oceľová karabína KRATOS | 1 |
| 50 | Odevná šnúra | 81 |
| 51 | Oracal 6510 Fluorescentná red orange 1,26x50m | 0 |
| 52 | P1 frame | 0 |
| 53 | Papsule keder PVC 4/10 oranžový | 66 |
| 54 | PE vrecia-tenké | 59 |
| 55 | PES 560D 64T - olivová  1,47 x 40 m | 92.08 |
| 56 | Plastel TE 62 8800-119 | 0 |
| 57 | Plastová podložka pod nity 35.51 | 2865 |
| 58 | Plastová podložka pod nity A-25/35.25 | 5745 |
| 59 | Podlahová guma  šírka 1,2 m Hr.3mm | 0 |
| 60 | Pozinkované krúžky 25mm automatické | 53290 |
| 61 | Pracka opasková posúvač 40348 40 | 0 |
| 62 | Protihlukový plot | 0 |
| 63 | PVC mäkčené pásy Standart 2/200mm | 75.42 |
| 64 | PVC mäkčené pásy Standart 2/300mm namodrasta | 0 |
| 65 | PVC poškodená | 0 |
| 66 | Reflexná páska heat transfer silver PU 25mm | -4484.65 |
| 67 | Reflexná páska heat transfer silver PU 50mm | 1403.867 |
| 68 | Reťaz poisťovací 10x150 cm | 0 |
| 69 | Serge Ferrari meshes 362- 1075 čierna | 0 |
| 70 | Serge Ferrari meshes 362- 50201 zelená | 74.31 |
| 71 | Sieťka  362- zelená (2050x1335 mm) | 740 |
| 72 | Sieťka 362- 50201 zelená 1320mm - mesh | 132.71 |
| 73 | Silver reflective tape FR 25 mm | 985.5 |
| 74 | Silver reflective tape FR 50 mm | 648.9 |
| 75 | Sioline B6148- 5488 (modrá)  900g  2,67 x 54 m | 4124.16 |
| 76 | Sioline B6148- 6444 (zelená)  900g  2,67 x 54 m | 11753.34 |
| 77 | Sioline B8103 - 6001 (zelená)  650g  2,5 x 65 m | 0 |
| 78 | Špirálová metráž No 10 biela ZIPS | 88.58 |
| 79 | Špirálová metráž No 10 čierna ZIPS | 86.52 |
| 80 | Špirálová metráž NO 5 mm biela ZIPS | 0 |
| 81 | Špirálová metráž NO 5 mm čierna ZIPS | 146.92 |
| 82 | Špirálová metráž NO 5 mm hnedá ZIPS | 0 |
| 83 | Špirálová metráž No 8 čierna ZIPS YKK | 79.45 |
| 84 | Suchý zips 10 cm biely háčik 102 | 28.56 |
| 85 | Suchý zips 10 cm biely vlas 102 | 0 |
| 86 | Suchý zips 10 cm čierny háčik 102 | 51.4 |
| 87 | Suchý zips 10 cm čierny vlas 102 | 299.1 |
| 88 | Suchý zips 25 mm, biely- háčik | 65.6 |
| 89 | Suchý zips 25 mm, čierny- háčik | 40.11 |
| 90 | Suchý zips 25 mm, čierny- vlas | 37.5 |
| 91 | Suchý zips 38 mm, biely- háčik | 27.84 |
| 92 | Suchý zips 38 mm, biely- vlas | 28.64 |
| 93 | Suchý zips 38 mm, čierny- háčik | 2.75 |
| 94 | Suchý zips 38 mm, čierny- vlas | 31.354 |
| 95 | Suchý zips 50 mm, biely- háčik | 59.083 |
| 96 | Suchý zips 50 mm, biely- vlas | 35 |
| 97 | Suchý zips 50 mm, čierny- háčik | 59.24 |
| 98 | Suchý zips 50 mm, čierny- vlas | 252.38 |
| 99 | Tepelná izolácia DAPE ABA parotesná 96 x 500 cm | -6.8 |
| 100 | TESA - Obojstranná lepiaca páska 50mmx25m/50m | 672.5 |
| 101 | Texa  do  železa  4,8X25 | 697 |
| 102 | TK.PE 700 modro-modra | 0 |
| 103 | TK.PE 753 modrý kašír | 2279.41 |
| 104 | TK.PE 760 modro-čierna | 0 |
| 105 | Tričko CXS EMILY, dámske | 0 |
| 106 | Valmex Torabdichtung 2mm  2,1m | 55.02 |
| 107 | Vinytol 701 N | 0 |
| 108 | Vinytol 701/1209 sivá | 22.5 |
| 109 | Vinytol 701/6604 žltá | 30 |
| 110 | Vinytol 701/8160 červená | 25.5 |
| 111 | Výstuhy | 0 |
| 112 | Zips UH7 630cm | 0 |
