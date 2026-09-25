-- The account_registry webhook fires when a USA or Canada code changes, not on
-- every write.
--
-- generate_account_code posts the whole row to an n8n webhook, which PATCHes the
-- HubSpot company's usa_xero_account_code and canada_xero_account_code with the
-- row's values. Those two columns are all it carries. Firing on every INSERT and
-- UPDATE meant any other write (a France account code, a name) rewrote those two
-- HubSpot fields for nothing, and a new row with no codes sent them empty.
--
-- The trigger was made in the Supabase dashboard as a database webhook, so this
-- is its first appearance in a migration. Its call (the webhook URL, method,
-- headers and timeout) is read from the live trigger and reused as it is,
-- because this repository is public and that webhook takes no secret.

do $$
declare
  current_def text;
  action text;
begin
  select pg_get_triggerdef(t.oid) into current_def
  from pg_trigger t
  where t.tgrelid = 'public.account_registry'::regclass
    and t.tgname = 'generate_account_code'
    and not t.tgisinternal;

  if current_def is null then
    raise exception 'generate_account_code is not on account_registry';
  end if;
  if current_def not like 'CREATE TRIGGER generate_account_code AFTER INSERT OR UPDATE ON public.account_registry FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(%' then
    raise exception 'generate_account_code is not the dashboard webhook this migration was written for';
  end if;

  action := substring(current_def from 'EXECUTE FUNCTION .*$');

  execute 'drop trigger generate_account_code on public.account_registry';

  -- An update fires only when one of the two codes actually changes.
  execute 'create trigger generate_account_code'
    || ' after update of usa_xero_account_code, canada_xero_account_code on public.account_registry'
    || ' for each row when (old.usa_xero_account_code is distinct from new.usa_xero_account_code'
    || ' or old.canada_xero_account_code is distinct from new.canada_xero_account_code) '
    || action;

  -- A new row fires only when it arrives carrying a code.
  execute 'create trigger generate_account_code_on_insert'
    || ' after insert on public.account_registry'
    || ' for each row when (coalesce(new.usa_xero_account_code, '''') <> '''''
    || ' or coalesce(new.canada_xero_account_code, '''') <> '''') '
    || action;
end $$;

do $$
begin
  if (select count(*) from pg_trigger
      where tgrelid = 'public.account_registry'::regclass and not tgisinternal) <> 2 then
    raise exception 'account_registry should carry exactly the two webhook triggers';
  end if;
end $$;
