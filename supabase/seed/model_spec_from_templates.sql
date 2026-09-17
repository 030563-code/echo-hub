-- Generated from bamida-spec-templates/specs.json. Do not hand-edit; regenerate.
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('CSCompact', 'CSC', 'CS barrier ( tlačový súbor 2500 x 2050mm )', null,
  null, 'Logo Galldris group UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dp POZOR!!! Ikony platné podľa posledných aktualizácií pre CSC, Warning sign Yellow ENG Grafiku poslať na schválenie', 'PVC Mehler 900gr/ B1/matný lak L&B 8540-636', '6026', 'Zelena/Green',
  null, null, 'PC350FR GRADE 6 /2,1m (600*600 PU2,1m) FR/WR/SolutionDyed', 'Čierna/Black',
  'SENIZOL EB3 1050g', '1580 x 960 x 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/210x140 a', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], 'na 1 paletu', null,
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('CSFullSize', 'CS R10', 'CS 1335 ( 1335 x 2050mm )', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Ikony pre CS R10 platné podľa posledných aktualizácií,','Nový Warning sign 2023!','Grafiku poslať na schválenie'], null, 'PVC Mheler 900gr/ B1/matný lak 8540 - 606', '6026', 'zelená/Green',
  null, null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierna/Black',
  'SENIZOL EB3 1050g', '1580 x 960 x 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zvaraneíe', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/210x140', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], '1x2ks', 'Frame',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('CSPlus', 'CS Plus', 'CS 2,4x4,4 END Barrier( 2800 x 2050 mm) 2 ks na stan', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Ikony pre CS Plus platné podľa posledných aktualizácií,','Warning sign ENG Yellow','Grafika ENG','Grafiku poslať na schválenie'], null, 'PVC Mheler 900gr/ B1/matný lak = 8540 - 606', '6026', 'Zelená/ Green',
  null, null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierna/Black',
  'SENIZOL EB3 1050g', '1580 x 960 x 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/210x140', 'NIE', 'MAX výška palety 235 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], '1x1 ks', 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('H10', 'Echo Barrier H10', '1335 x 2050 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dp',
  array['Ikony platné podľa posledných aktualizácií pre H10','Nový Warning sign 11/2023 (yellow)','Grafiku poslať na schválenie'], null, 'PVC Mheler 900gr/ B1/matný lak L&B 8540 -606', null, 'Zelená/Green',
  'Ferrari 362', 'RAL 6005 (green)', 'PC200FR', 'Oranžová/Orange',
  'SENIZOL EB3 (1050g)', '1580 x 960 x TL 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/Zvaranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], null, 'Háky /Lanká',
  'template', 'Template recorded RAL 606, which is the L&B fabric suffix rather than a RAL colour; the RAL is unconfirmed.')
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('H8', 'Echo Barrier H8', '3650 x 2050 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Aktuálna grafika platná pre H8,','Nový Warning sign 2023!!','Grafiku poslať na schválenie.'], null, 'Mehler/680gr/B1/lesklý lak 8509 – 636', '6026', 'Zelená/Green',
  null, null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierná/Black',
  'SENIZOL EB3 (800g)', '1580 x 1000 x TL 35 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('H8Mini', 'Echo Barrier H8 MINI', '( 1793 x 1010mm )', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Aktuálna grafika platná pre H8 MINI,','Nový Warning sign 2023!!','Grafiku poslať na schválenie.'], null, 'Mehler/680gr/B1/lesklý lak', null, 'Zelená/Green',
  null, null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierná/Black',
  'SENIZOL EB3 (800g)', '1580 x 1000 x TL 35 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 12 mm / pozinkované', 'FYTO/označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('H9Mini', 'Echo Barrier H9 MINI', '1010 x 658 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Nové ikonky platné podľa posledných aktualizácii pre H9 MINI','Warning sign ENG (Yellow)','Grafika ENG','Grafiku poslať na schválenie.'], null, 'PVC Mehler 900gr/ B1/matný lak L&B 8540-606', '6026', 'Zelená/Green',
  '-----------------------', null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierna/Black',
  'SENIZOL EB3 (1050g)', '788 x 492 x TL 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zvaranie', 'Strieborná/Silver',
  'D 12 mm / pozinkované', '210x140 Fyto', 'Ano', 'MAX výška palety 235 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], 'Spraviť Baliky po 20ks , baliky nasledne naskladat na 2 palety', 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('H9X', 'Echo Barrier H9X', '1335 x 2550 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Nové ikonky platné podľa posledných aktualizácii pre H9X','Nový Warning sign 2023','Grafiku poslať na schválenie.'], null, 'PVC Mheler 900gr/ B1/matný lak L&B 8540 -606', null, 'Zelená/Green',
  '-----------------------', null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierna/Black',
  'SENIZOL EB3 (1050g)', '1580 x 960 x TL 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], null, 'Háky /Lanká',
  'template', 'Template recorded RAL 606, which is the L&B fabric suffix rather than a RAL colour; the RAL is unconfirmed.')
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('HT3.5', 'Echo Barrier HT 3,5', '3650 x 2050mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Ikony platné podľa posledných aktualizácií pre HT3,5','Nový Warning sign 2023','Grafiku poslať na schválenie'], null, 'Plastel, 620 gr/m2, matt, ISO 3795<100, 1str.lak 8800 - 606', '6026', 'Zelená/Green',
  '-----------------------', null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'Čierna/Black',
  'SENIZOL EB3 (800g)', '1580 x 1000 x TL 35 mm', null,
  null, 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'FYTO/označená', 'NIE', 'štitky : MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('M1', 'Gen Set M1', 'M1 Barrier (1160x2240mm)', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi',
  array['Ikony platné podľa posledných aktualizácií pre CSC,','Nový Warning sign 2023 !,','Grafiku poslať na schválenie.'], null, 'PVC Mheler 900gr/ B1/matný lak', null, 'Zelená/Green',
  'Ferrari 362 (RAL 6005)', 'Zelená/Green', 'PC200FR', 'Oranžová/Orange',
  'SENIZOL EB3 (1050g)', '960 x 1575 mm', 'NC Tech',
  'oranžová/orange', 'áno zvaranie', 'strieborná/silver',
  'D 25 mm / mosadzné', 'FYTO/označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('NDS', 'Noise Defender (RS-200)', '1250 x 2050 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dpi Ikony platné podľa posledných aktualizácií pre NDs Nový Warning sign 2023 Grafiku poslať na schválenie',
  null, null, 'PVC 900g/ B1/lesklé/určené pre', null, 'Blue/modrá',
  '-----------------------', null, 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/ Solution Dyed', 'čierna/Black',
  'SENIZOL EB3 (800 g)', '1000x1580mm/TL35mm', 'Strongbond V2035',
  'Čierna/Black', 'áno(50 mm) Zváranie', 'strieborná/silver',
  'D 25 mm / pozinkované', 'FYTO/označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barrier'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('V1', 'Echo barrier V1', '2450 x 1950 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dp',
  array['Ikony platné podľa posledných aktualizácií pre V1,','Nový Warning sign 2023','Grafiku poslať na schválenie'], null, 'PVC Mheler 900gr/ B1/matný lak', null, 'Modrá/Blue',
  null, null, 'PC350FR GRADE 6 /2,1m (600*600 PU2,1m)FR/WR/SolutionDyed', 'Čierna/Black',
  'SENIZOL EB3 (1050g)', '1580 x 960 x TL 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)','Kotvenie na paletu cez oká Barier'], null, 'Háky /Lanká',
  'template', null)
on conflict (model_code) do nothing;
insert into public.model_spec (model_code, product_label, dimensions, graphics_print, graphics_notes,
  graphics_with_logo, pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour,
  infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour,
  rings, pallet_type, construction, max_pallet_height, specific_requirements, pack_config,
  include_with_order, source_document, notes)
values ('V2', 'Echo barrier V2', '2330 x 1885 mm', 'UV biela tlač / w3+cmyk2 / 230 % white / 1080x360dp',
  array['Ikony platné podľa posledných aktualizácií pre V2,','Nový Warning sign 2023','Grafiku poslať na schválenie'], null, 'PVC Mheler 900gr/ B1/matný lak', '6026', 'Zelená/green',
  null, null, 'PC350FR GRADE 6 /2,1m (600*600 PU2,1m)FR/WR/SolutionDyed', 'Čierna/Black',
  'SENIZOL EB3 (1050g)', '1400 x 960 x TL 40 mm', 'NC Tech',
  'Oranžová/Orange', 'áno/zváranie', 'Strieborná/Silver',
  'D 25 mm / mosadzné', 'označená', 'NIE', 'MAX výška palety 245 cm !!!',
  array['obojstranná lepiaca páska – Lohmann DuploCOLLO 3702– lepenie v pomere 2-1-1-1 na jednu bariéru a (podľa stanovených štandardov),','scanovanie datatagov','označovanie paliet (kódy paliet = 2 ks/paleta),','inštalácia nálepiek (kód krajiny + počet ks bariér na palete = 2 ks/paleta)'], null, null,
  'template', null)
on conflict (model_code) do nothing;
