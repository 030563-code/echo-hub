begin;

insert into public.mrp_stage_weights (stage_id, stage_label, win_weight, is_late_stage, seeded_manually) values
  ('demo_late_stage', 'DEMO Contract Sent', 0.35, true, true)
on conflict (stage_id) do nothing;

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior) values
  ('andy-demo-2026-08-09', 'insert', 'mrp_stage_weights', '{"stage_id":"demo_late_stage"}'::jsonb, null);

commit;
