-- Put the general list back to quoting at MSRP.
--
-- Only reverses rows this migration actually switched, which are exactly the
-- ones carrying an msrp_price. The column itself is left in place: dropping it
-- would throw away the MSRP tier a second time.
update public.list_prices
set unit_price = msrp_price,
    msrp_price = null,
    updated_by_label = 'rollback to MSRP',
    updated_at = now()
where msrp_price is not null;
