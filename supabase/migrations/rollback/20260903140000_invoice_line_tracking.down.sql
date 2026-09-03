alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_tracking_max_two;
alter table public.customer_invoice_lines drop column if exists tracking;
