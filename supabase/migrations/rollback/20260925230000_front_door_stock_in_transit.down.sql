-- Undo 20260925230000_front_door_stock_in_transit.sql.
--
-- Switches the stock_in_transit question off first, so the front door stops offering an answer it
-- can no longer compute, then drops its function.

update public.data_questions
set active = false, answer_function = null, definition = null, updated_at = now()
where key = 'stock_in_transit';

drop function if exists public.data_answer_stock_in_transit(text, text);
