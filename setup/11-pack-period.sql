-- 11 — Paid plans count patients per 30-day pack (from the payment date), not per calendar month.
-- Free accounts still get their allowance per calendar month (resets on the 1st).

alter table public.profiles add column if not exists pack_start timestamptz;

-- Which allowance period the user is in now. Pro: 30-day windows from pack_start. Free: 'YYYY-MM' (IST).
-- The app computes the same key (app.js usageKey) to show the meter, so keep the two in step.
create or replace function public.usage_key(p_pack timestamptz, p_until timestamptz)
returns text language plpgsql stable set search_path = public as $$
declare a timestamptz; idx int;
begin
  if p_until is not null and p_until > now() then
    -- No pack start (older accounts): 30-day windows counted back from the end date.
    a := coalesce(p_pack, p_until - make_interval(days => 30 * ceil(extract(epoch from (p_until - now())) / 2592000)::int));
    if a > now() then a := now(); end if;
    idx := floor(extract(epoch from (now() - a)) / 2592000)::int;
    return 'P' || floor(extract(epoch from a))::bigint || '#' || idx;
  end if;
  return to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM');
end $$;

create or replace function public.use_quota(p_user uuid, p_kind text, p_free_limit integer, p_pro_limit integer)
returns table(allowed boolean, used integer, quota integer, is_pro boolean, blocked boolean)
language plpgsql security definer set search_path = public as $$
declare
  m    text;
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

  m := public.usage_key(r.pack_start, r.pro_until);
  if r.usage_month is distinct from m then
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

-- Each payment starts a fresh pack: the counter starts at 0 from the payment time.
create or replace function public.grant_pro_for_order(p_order text, p_payment text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare o public.orders; until timestamptz;
begin
  select * into o from public.orders where order_id = p_order for update;
  if not found then raise exception 'unknown order'; end if;
  if o.status = 'paid' then
    select pro_until into until from public.profiles where id = o.user_id;
    return until;
  end if;
  update public.orders set status = 'paid', payment_id = p_payment, paid_at = now() where order_id = p_order;
  insert into public.payments (user_id, razorpay_payment_id, plan, amount_paise)
  values (o.user_id, p_payment, o.plan, o.amount_paise) on conflict (razorpay_payment_id) do nothing;
  update public.profiles
     set pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => o.days),
         plan = o.plan,
         pack_start = date_trunc('second', now())
   where id = o.user_id
  returning pro_until into until;
  return until;
end $$;

revoke all on function public.usage_key(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.use_quota(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.grant_pro_for_order(text, text) from public, anon, authenticated;

-- Existing Pro users: pack starts at their last payment, else 1st of this month; keep this period's count.
update public.profiles p
   set pack_start = date_trunc('second', coalesce(
         (select max(paid_at) from public.orders o where o.user_id = p.id and o.status = 'paid'),
         date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'))
 where p.pro_until > now() and p.pack_start is null;
update public.profiles
   set usage_month = public.usage_key(pack_start, pro_until)
 where pro_until > now() and usage_month = to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM');
grant execute on function public.usage_key(timestamptz, timestamptz) to service_role;

-- Admin user list: also return pack_start and the current period key, so "this period" counts are right.
create or replace function public.admin_users(p_q text, p_limit integer, p_offset integer)
returns jsonb language sql stable security definer set search_path = public as $$
  with f as (
    select p.* from profiles p
    where coalesce(p_q, '') = '' or p.email ilike '%' || p_q || '%'
  ), page as (
    select * from f order by created_at desc limit greatest(least(p_limit, 100), 1) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'created_at', u.created_at,
      'pro_until', u.pro_until, 'plan', u.plan, 'blocked', u.blocked,
      'usage_month', u.usage_month, 'extract_count', u.extract_count, 'generate_count', u.generate_count,
      'period_used', case when u.usage_month = usage_key(u.pack_start, u.pro_until) then u.extract_count else 0 end,
      'pack_start', u.pack_start,
      'templates', (select count(*) from templates t where t.user_id = u.id),
      'discharges_total', (select count(*) from usage_events e where e.user_id = u.id and e.kind = 'extract' and e.ok),
      'cost_usd_total', (select coalesce(sum(cost_usd), 0) from usage_events e where e.user_id = u.id),
      'paid_paise_total', (select coalesce(sum(amount_paise), 0) from payments y where y.user_id = u.id),
      'last_active', (select max(created_at) from usage_events e where e.user_id = u.id)
    ) order by u.created_at desc) from page u), '[]'::jsonb)
  )
$$;
