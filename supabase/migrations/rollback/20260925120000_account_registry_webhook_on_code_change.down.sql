-- Rollback of 20260925120000_account_registry_webhook_on_code_change.sql.
-- Puts back the single dashboard webhook that fires on every INSERT and UPDATE,
-- with the same call read back from the trigger it replaces. Every write to
-- account_registry, a France account code included, then PATCHes the company's
-- USA and Canada codes in HubSpot again.

do $$
declare
  action text;
begin
  select substring(pg_get_triggerdef(t.oid) from 'EXECUTE FUNCTION .*$') into action
  from pg_trigger t
  where t.tgrelid = 'public.account_registry'::regclass
    and t.tgname = 'generate_account_code'
    and not t.tgisinternal;

  if action is null then
    raise exception 'generate_account_code is not on account_registry';
  end if;

  execute 'drop trigger if exists generate_account_code_on_insert on public.account_registry';
  execute 'drop trigger generate_account_code on public.account_registry';
  execute 'create trigger generate_account_code after insert or update on public.account_registry for each row '
    || action;
end $$;
