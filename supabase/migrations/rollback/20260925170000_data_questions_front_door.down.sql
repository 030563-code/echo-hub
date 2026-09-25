-- Undo 20260925170000_data_questions_front_door.sql.
--
-- Drops the front door's catalogue, its decision log and its two functions. The log is the record
-- of every answer the front door gave, so export it first if it matters. Turn the front door off
-- in the Buzz bridge before running this, or every call to it will fail over to the agents.

drop function if exists public.data_answer_stock_on_hand(text, text);
drop function if exists public.stock_feed_freshness();
drop table if exists public.data_question_log;
drop table if exists public.data_questions;
