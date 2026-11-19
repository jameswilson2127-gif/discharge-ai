-- Admin panel: usage/cost log, payments, editable settings, block flag, admin queries.
-- No patient data is stored anywhere here — only counts, token numbers and costs.

alter table public.profiles add column if not exists blocked boolean not null default false;
alter table public.profiles add column if not exists plan    text;   -- 'monthly' | 'yearly'

-- ---------- Settings (single row, editable from the admin panel) ----------
create table if not exists public.app_settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id, data) values (1, jsonb_build_object(
  'free_extract', 5, 'pro_extract', 300,
  'free_generate', 20, 'pro_generate', 1000,
  'usd_inr', 88
)) on conflict (id) do nothing;
alter table public.app_settings enable row level security;   -- no policies: service role only

-- ---------- AI usage log (one row per AI call) ----------
create table if not exists public.usage_events (
  id            bigserial primary key,
  user_id       uuid references auth.users(id) on delete set null,
  kind          text not null check (kind in ('extract', 'generate', 'template')),
  ok            boolean not null,
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,   -- includes thinking tokens (billed as output)
  cost_usd      numeric(12, 6) not null default 0,
  error         text,                      -- short technical message, never patient data
  created_at    timestamptz not null default now()
);
create index if not exists usage_events_created_idx on public.usage_events (created_at desc);
create index if not exists usage_events_user_idx on public.usage_events (user_id, created_at desc);
alter table public.usage_events enable row level security;   -- service role only

-- ---------- Payments (from Razorpay webhook) ----------
create table if not exists public.payments (
  id                  bigserial primary key,
  user_id             uuid references auth.users(id) on delete set null,
  razorpay_payment_id text unique,
  subscription_id     text,
  plan                text,
  amount_paise        int not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists payments_created_idx on public.payments (created_at desc);
alter table public.payments enable row level security;       -- service role only

-- ---------- Quota: limits from settings, respects blocked accounts ----------
drop function if exists public.use_quota(uuid, text, int, int);
create function public.use_quota(
  p_user uuid, p_kind text, p_free_limit int, p_pro_limit int
) returns table (allowed boolean, used int, quota int, is_pro boolean, blocked boolean)
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
    when p_kind = 'extract' and pro     then coalesce((s->>'pro_extract')::int,   p_pro_limit)
    when p_kind = 'extract'             then coalesce((s->>'free_extract')::int,  p_free_limit)
    when pro                            then coalesce((s->>'pro_generate')::int,  p_pro_limit)
    else                                     coalesce((s->>'free_generate')::int, p_free_limit)
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

-- Public, read-only view of the free limit so the app can display it.
create or replace function public.public_limits()
returns jsonb language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'free_extract', coalesce((data->>'free_extract')::int, 5),
    'pro_extract',  coalesce((data->>'pro_extract')::int, 300))
  from public.app_settings where id = 1
$$;

-- ---------- Admin queries (service role only) ----------
create or replace function public.admin_overview()
returns jsonb language sql security definer set search_path = public stable as $$
  with b as (
    select (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as ms
  )
  select jsonb_build_object(
    'users_total',        (select count(*) from profiles),
    'users_7d',           (select count(*) from profiles where created_at > now() - interval '7 days'),
    'pro_users',          (select count(*) from profiles where pro_until > now()),
    'blocked_users',      (select count(*) from profiles where blocked),
    'templates_total',    (select count(*) from templates),
    'discharges_month',   (select count(*) from usage_events, b where kind = 'extract' and ok and created_at >= b.ms),
    'discharges_total',   (select count(*) from usage_events where kind = 'extract' and ok),
    'summaries_month',    (select count(*) from usage_events, b where kind = 'generate' and ok and created_at >= b.ms),
    'summaries_total',    (select count(*) from usage_events where kind = 'generate' and ok),
    'cost_usd_month',     (select coalesce(sum(cost_usd), 0) from usage_events, b where created_at >= b.ms),
    'cost_usd_total',     (select coalesce(sum(cost_usd), 0) from usage_events),
    'cost_by_kind_month', (select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb) from (
                             select kind, sum(cost_usd) c from usage_events, b where created_at >= b.ms group by kind) k),
    'cost_by_kind_total', (select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb) from (
                             select kind, sum(cost_usd) c from usage_events group by kind) k),
    'revenue_paise_month',(select coalesce(sum(amount_paise), 0) from payments, b where created_at >= b.ms),
    'revenue_paise_total',(select coalesce(sum(amount_paise), 0) from payments),
    'errors_7d',          (select count(*) from usage_events where not ok and created_at > now() - interval '7 days'),
    'settings',           (select data from app_settings where id = 1)
  )
$$;

create or replace function public.admin_users(p_q text, p_limit int, p_offset int)
returns jsonb language sql security definer set search_path = public stable as $$
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
      'templates', (select count(*) from templates t where t.user_id = u.id),
      'discharges_total', (select count(*) from usage_events e where e.user_id = u.id and e.kind = 'extract' and e.ok),
      'cost_usd_total', (select coalesce(sum(cost_usd), 0) from usage_events e where e.user_id = u.id),
      'paid_paise_total', (select coalesce(sum(amount_paise), 0) from payments y where y.user_id = u.id),
      'last_active', (select max(created_at) from usage_events e where e.user_id = u.id)
    ) order by u.created_at desc) from page u), '[]'::jsonb)
  )
$$;

create or replace function public.admin_daily(p_days int)
returns jsonb language sql security definer set search_path = public stable as $$
  with d as (
    select (created_at at time zone 'Asia/Kolkata')::date as day, kind, ok, cost_usd
    from usage_events where created_at > now() - make_interval(days => greatest(least(p_days, 90), 1))
  )
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(x order by x->>'day' desc) from (
      select jsonb_build_object(
        'day', day,
        'discharges', count(*) filter (where kind = 'extract' and ok),
        'summaries',  count(*) filter (where kind = 'generate' and ok),
        'templates',  count(*) filter (where kind = 'template' and ok),
        'errors',     count(*) filter (where not ok),
        'cost_usd',   coalesce(sum(cost_usd), 0)) x
      from d group by day) q), '[]'::jsonb),
    'recent_errors', coalesce((select jsonb_agg(jsonb_build_object(
        'at', e.created_at, 'kind', e.kind, 'error', e.error, 'email', p.email) order by e.created_at desc)
      from (select * from usage_events where not ok order by created_at desc limit 20) e
      left join profiles p on p.id = e.user_id), '[]'::jsonb)
  )
$$;

revoke execute on function public.use_quota(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.use_quota(uuid, text, int, int) to service_role;
revoke execute on function public.admin_overview()               from public, anon, authenticated;
revoke execute on function public.admin_users(text, int, int)    from public, anon, authenticated;
revoke execute on function public.admin_daily(int)               from public, anon, authenticated;
grant  execute on function public.admin_overview()               to service_role;
grant  execute on function public.admin_users(text, int, int)    to service_role;
grant  execute on function public.admin_daily(int)               to service_role;
grant  execute on function public.public_limits()                to anon, authenticated;
grant  select, insert, update, delete on public.usage_events, public.payments, public.app_settings to service_role;
grant  usage, select on sequence public.usage_events_id_seq, public.payments_id_seq to service_role;
