-- 14 — Referrals. A doctor shares a link; a referral counts once the friend has completed 2 discharges.
-- 5 real referrals = 50 bonus discharges; each referral from 6 to 10 = +10 more (100 max).
-- Bonus discharges are used only after the pack / monthly allowance runs out, and stay valid 90 days
-- from the latest reward.

alter table public.profiles add column if not exists ref_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists ref_qualified_at timestamptz;
alter table public.profiles add column if not exists bonus_left integer not null default 0;
alter table public.profiles add column if not exists bonus_until timestamptz;
alter table public.profiles add column if not exists ref_bonus_granted integer not null default 0;
create index if not exists profiles_referred_by_idx on public.profiles (referred_by);

-- Reward for n qualified referrals.
create or replace function public.ref_reward(n integer) returns integer language sql immutable as $$
  select case when n < 5 then 0 else 50 + 10 * (least(n, 10) - 5) end
$$;

-- Give the referrer any reward they have newly earned.
create or replace function public.grant_ref_bonus(p_referrer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare q int; due int; r public.profiles;
begin
  select * into r from public.profiles where id = p_referrer for update;
  if not found then return; end if;
  select count(*) into q from public.profiles where referred_by = p_referrer and ref_qualified_at is not null;
  due := public.ref_reward(q) - coalesce(r.ref_bonus_granted, 0);
  if due > 0 then
    update public.profiles
       set bonus_left = case when bonus_until is not null and bonus_until > now() then bonus_left else 0 end + due,
           bonus_until = now() + interval '90 days',
           ref_bonus_granted = coalesce(ref_bonus_granted, 0) + due
     where id = p_referrer;
  end if;
end $$;

-- A friend qualifies after 2 completed discharges (2 different patients read successfully).
create or replace function public.ref_check_qualified() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.profiles; n int;
begin
  if new.kind <> 'extract' or not new.ok or new.user_id is null then return new; end if;
  select * into p from public.profiles where id = new.user_id;
  if p.referred_by is null or p.ref_qualified_at is not null then return new; end if;
  select count(distinct case_id) into n from public.usage_events
   where user_id = new.user_id and kind = 'extract' and ok and case_id is not null;
  if n >= 2 then
    update public.profiles set ref_qualified_at = now() where id = new.user_id and ref_qualified_at is null;
    perform public.grant_ref_bonus(p.referred_by);
  end if;
  return new;
end $$;
drop trigger if exists usage_ref_qualify on public.usage_events;
create trigger usage_ref_qualify after insert on public.usage_events
  for each row execute function public.ref_check_qualified();

-- Called by a newly signed-up doctor who arrived through a referral link.
create or replace function public.claim_referral(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare me public.profiles; ref uuid;
begin
  select * into me from public.profiles where id = auth.uid() for update;
  if not found then return 'no_profile'; end if;
  if me.referred_by is not null then return 'already'; end if;
  if me.created_at < now() - interval '7 days' then return 'not_new'; end if;
  select id into ref from public.profiles where ref_code = upper(trim(p_code));
  if ref is null then return 'bad_code'; end if;
  if ref = me.id then return 'self'; end if;
  update public.profiles set referred_by = ref where id = me.id;
  return 'ok';
end $$;

-- The doctor's own referral status (creates their code on first use).
create or replace function public.my_referrals() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles; code text; i int := 0; joined int; qualified int;
begin
  select * into me from public.profiles where id = auth.uid() for update;
  if not found then return null; end if;
  code := me.ref_code;
  while code is null loop
    code := upper(substr(md5(me.id::text || i::text || clock_timestamp()::text), 1, 6));
    if exists (select 1 from public.profiles where ref_code = code) then code := null; i := i + 1;
    else update public.profiles set ref_code = code where id = me.id; end if;
  end loop;
  select count(*), count(*) filter (where ref_qualified_at is not null) into joined, qualified
    from public.profiles where referred_by = me.id;
  return jsonb_build_object('code', code, 'joined', joined, 'qualified', qualified,
    'earned', public.ref_reward(qualified),
    'bonus_left', case when me.bonus_until > now() then me.bonus_left else 0 end, 'bonus_until', me.bonus_until);
end $$;

-- Quota: bonus discharges are used only after the normal allowance is used up.
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
  bonus boolean;
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
  bonus := coalesce(r.bonus_left, 0) > 0 and r.bonus_until is not null and r.bonus_until > now();

  if cur >= lim then
    if bonus and p_kind = 'extract' then
      update public.profiles set bonus_left = bonus_left - 1 where id = p_user;
      return query select true, cur, lim, pro, false;
      return;
    elsif p_kind = 'generate' and r.bonus_until is not null and r.bonus_until > now() and coalesce(r.ref_bonus_granted, 0) > 0 then
      -- writing stays free during a referral-bonus period (so the last bonus discharge can still be written)
      return query select true, cur, lim, pro, false;
      return;
    end if;
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

revoke all on function public.ref_reward(integer) from public, anon;
revoke all on function public.grant_ref_bonus(uuid) from public, anon, authenticated;
revoke all on function public.ref_check_qualified() from public, anon, authenticated;
revoke all on function public.use_quota(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_referral(text) from public, anon;
revoke all on function public.my_referrals() from public, anon;
grant execute on function public.claim_referral(text) to authenticated;
grant execute on function public.my_referrals() to authenticated;
