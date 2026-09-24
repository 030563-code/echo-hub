-- Rollback of 20260924200000_cargo_remove_hand_added_spot.sql.
-- A shipment added by hand can no longer be taken back off the board. Nothing removed with it
-- comes back: it was deleted.
drop function if exists public.cargo_remove_hand_added_spot(text);
