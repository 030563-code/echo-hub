alter table public.customer_invoices
  drop column if exists billing_name,
  drop column if exists billing_line1,
  drop column if exists billing_line2,
  drop column if exists billing_city,
  drop column if exists billing_region,
  drop column if exists billing_postal_code,
  drop column if exists billing_country,
  drop column if exists billing_email,
  drop column if exists billing_snapshot_at;
