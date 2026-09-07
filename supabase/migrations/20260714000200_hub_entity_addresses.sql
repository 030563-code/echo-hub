-- Correct entity addresses from Echo Barrier's own directory (echobarrier.co.uk).
-- EB-GROUP was carrying the UK entity's Bury St Edmunds address under the Group's
-- legal name; the Group Head Office is Dublin. SRO reformatted. EB-USA left as-is
-- (the Baltimore/Jessup warehouse address is correct). default_currency unchanged
-- (invoicing uses it; the PO-document currency is handled separately in the app).
update public.entities
   set legal_name    = 'Echo Barrier Group Limited',
       address_lines = array['41 Central Chambers','Dame Court','Dublin','D02 W729','Republic of Ireland']
 where code = 'EB-GROUP';

update public.entities
   set legal_name    = 'Echo Barrier s.r.o.',
       address_lines = array['Sturova 3/6','040 01 Kosice','Slovakia']
 where code = 'EB-SRO';
