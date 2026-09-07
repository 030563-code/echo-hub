-- ============================================================================
-- Echo Barrier Hub — GROUP_TO_USA transfer prices (commercial-invoice slice 2).
-- Target: ops korylyniwsqtsvzuzydg. PURELY ADDITIVE (seed rows only).
--
-- The USD Group→USA invoice values come from these EUR BASE prices, converted to
-- USD at issue via the rolling-13-week EUR_USD rate (snapshotted on the invoice).
-- Seeded equal to the SRO→Group prices (BOM SRO cost) as a STARTING POINT — Dean/
-- Martin set the real Group→USA prices (typically SRO cost + Group margin).
-- ============================================================================

INSERT INTO public.intercompany_prices (sku, leg, unit_value, currency) VALUES
  ('CCSNA',       'GROUP_TO_USA', 215.33, 'EUR'),
  ('EBH10HERCNA', 'GROUP_TO_USA',  22.38, 'EUR'),
  ('EBH10NA',     'GROUP_TO_USA',  25.68, 'EUR'),
  ('EBH8NA',      'GROUP_TO_USA',  68.65, 'EUR'),
  ('EBH9ERNA',    'GROUP_TO_USA',  27.01, 'EUR'),
  ('EBH9NA',      'GROUP_TO_USA',  27.01, 'EUR'),
  ('EBH9WNA',     'GROUP_TO_USA',  27.01, 'EUR'),
  ('EBH9XNA',     'GROUP_TO_USA',  43.72, 'EUR'),
  ('FSCNA',       'GROUP_TO_USA', 293.67, 'EUR'),
  ('M1NA',        'GROUP_TO_USA', 100.89, 'EUR'),
  ('V2NA',        'GROUP_TO_USA',  62.56, 'EUR')
ON CONFLICT (sku, leg) DO NOTHING;
