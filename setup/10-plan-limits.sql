-- Three Pro plans with their own monthly limits; yearly switched off ("coming soon"). Run after file 9.
--   pro100  : ₹199 offer (₹399 regular), 100 patients / month, 30 days
--   monthly : ₹599 offer (₹999 regular), 300 patients / month, 30 days
--   yearly  : ₹6,999 offer (₹9,999 regular), 300 / month, 365 days, enabled = false for now
update public.app_settings set data = jsonb_set(data, '{pricing}', coalesce(data->'pricing', '{}'::jsonb) || jsonb_build_object(
  'pro100',  jsonb_build_object('list', 399,  'price', 199,  'days', 30,  'limit', 100, 'enabled', true),
  'monthly', coalesce(data->'pricing'->'monthly', '{}'::jsonb) || jsonb_build_object('limit', 300, 'enabled', true),
  'yearly',  coalesce(data->'pricing'->'yearly',  '{}'::jsonb) || jsonb_build_object('limit', 300, 'enabled', false)))
where id = 1;

alter table public.orders drop constraint if exists orders_plan_check;
alter table public.orders add constraint orders_plan_check check (plan in ('pro100', 'monthly', 'yearly'));

-- Pro limit now follows the plan the user bought (pricing.<plan>.limit); older/manual plans
-- fall back to the general Pro limit from settings.
create or replace function public.use_quota(p_user uuid, p_kind text, p_free_limit int, p_pro_limit int)
returns table (allowed boolean, used int, quota int, is_pro boolean, blocked boolean)
language plpgsql security definer set search_path = public as $$
declare
  m    text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM');
  s    jsonb := coalesce((select data from public.app_settings where id = 1), '{}'::jsonb);
  r    public.profiles;
  lim  int;
  cur  int;
  pro  boolean;
begin
  if p_kind not in ('extract', 'generate') then
    raise exception 'bad kind %', p_kind;
  end if;

  insert into public.profiles (id) values (p_user) on conflict (id) do nothing;
  select * into r from public.profiles where id = p_user for update;

  pro := r.pro_until is not null and r.pro_until > now();
  if r.blocked then
    return query select false, 0, 0, pro, true;
    return;
  end if;

  if r.usage_month <> m then
    update public.profiles set usage_month = m, extract_count = 0, generate_count = 0 where id = p_user;
    r.extract_count := 0;
    r.generate_count := 0;
  end if;

  lim := case
    when p_kind = 'extract' and pro then coalesce((s->'pricing'->coalesce(r.plan, '')->>'limit')::int,
                                                  (s->>'pro_extract')::int, p_pro_limit)
    when p_kind = 'extract'         then coalesce((s->>'free_extract')::int,  p_free_limit)
    when pro                        then coalesce((s->>'pro_generate')::int,  p_pro_limit)
    else                                 coalesce((s->>'free_generate')::int, p_free_limit)
  end;
  cur := case when p_kind = 'extract' then r.extract_count else r.generate_count end;

  if cur >= lim then
    return query select false, cur, lim, pro, false;
    return;
  end if;

  if p_kind = 'extract' then
    update public.profiles set extract_count = extract_count + 1 where id = p_user;
  else
    update public.profiles set generate_count = generate_count + 1 where id = p_user;
  end if;

  return query select true, cur + 1, lim, pro, false;
end $$;
revoke execute on function public.use_quota(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.use_quota(uuid, text, int, int) to service_role;
