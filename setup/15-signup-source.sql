-- 15 — Where signups come from (?src=medbulletin, utm_source=…, referral links).
-- A short label only; saved once for a new account and never overwritten.
alter table public.profiles add column if not exists signup_source text;

create or replace function public.set_signup_source(p_src text) returns text
language plpgsql security definer set search_path = public as $$
declare me public.profiles; v text;
begin
  v := left(regexp_replace(lower(coalesce(p_src, '')), '[^a-z0-9_.-]', '', 'g'), 40);
  if v = '' then return 'empty'; end if;
  select * into me from public.profiles where id = auth.uid() for update;
  if not found then return 'no_profile'; end if;
  if me.signup_source is not null then return 'already'; end if;
  if me.created_at < now() - interval '2 days' then return 'not_new'; end if;
  update public.profiles set signup_source = v where id = me.id;
  return 'ok';
end $$;
revoke all on function public.set_signup_source(text) from public, anon;
grant execute on function public.set_signup_source(text) to authenticated;

-- Referral signups without another source are labelled "referral".
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
  update public.profiles set referred_by = ref, signup_source = coalesce(signup_source, 'referral') where id = me.id;
  return 'ok';
end $$;
revoke all on function public.claim_referral(text) from public, anon;
grant execute on function public.claim_referral(text) to authenticated;

-- Admin: signups, activation, payers and revenue per source.
create or replace function public.admin_sources() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.signups desc), '[]'::jsonb) from (
    select coalesce(p.signup_source, 'unknown') as source,
      count(*) as signups,
      count(*) filter (where p.created_at > now() - interval '7 days') as last_7d,
      count(*) filter (where exists (select 1 from usage_events e where e.user_id = p.id and e.kind = 'extract' and e.ok)) as made_discharge,
      count(*) filter (where exists (select 1 from payments y where y.user_id = p.id)) as paid,
      coalesce(sum((select sum(amount_paise) from payments y where y.user_id = p.id)), 0) as revenue_paise
    from profiles p group by 1
  ) x
$$;
revoke all on function public.admin_sources() from public, anon, authenticated;
grant execute on function public.admin_sources() to service_role;
