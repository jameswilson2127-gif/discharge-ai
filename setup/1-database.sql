-- Discharge AI: accounts, subscription status and monthly usage.
-- No patient data is ever stored in this database.
-- Run this once in Supabase → SQL Editor (or `supabase db push`).

create table if not exists public.profiles (
  id                        uuid primary key references auth.users(id) on delete cascade,
  email                     text,
  pro_until                 timestamptz,          -- null or past = free plan
  razorpay_subscription_id  text,
  usage_month               text not null default to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'),
  extract_count             int  not null default 0,   -- photo-reading runs this month
  generate_count            int  not null default 0,   -- discharge drafts written this month
  created_at                timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users may only READ their own row. All writes happen in edge functions
-- with the service-role key, so users cannot give themselves Pro.
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Create a profile row automatically on first Google sign-in.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomically check and consume one unit of quota.
-- p_kind: 'extract' or 'generate'. Resets counters at the start of each month (IST).
create or replace function public.use_quota(
  p_user uuid, p_kind text, p_free_limit int, p_pro_limit int
) returns table (allowed boolean, used int, quota int, is_pro boolean)
language plpgsql security definer set search_path = public as $$
declare
  m    text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM');
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

  if r.usage_month <> m then
    update public.profiles
       set usage_month = m, extract_count = 0, generate_count = 0
     where id = p_user;
    r.extract_count := 0;
    r.generate_count := 0;
  end if;

  pro := r.pro_until is not null and r.pro_until > now();
  lim := case when pro then p_pro_limit else p_free_limit end;
  cur := case when p_kind = 'extract' then r.extract_count else r.generate_count end;

  if cur >= lim then
    return query select false, cur, lim, pro;
    return;
  end if;

  if p_kind = 'extract' then
    update public.profiles set extract_count = extract_count + 1 where id = p_user;
  else
    update public.profiles set generate_count = generate_count + 1 where id = p_user;
  end if;

  return query select true, cur + 1, lim, pro;
end $$;

-- Give a unit back if the AI call failed.
create or replace function public.refund_quota(p_user uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'extract' then
    update public.profiles set extract_count = greatest(extract_count - 1, 0) where id = p_user;
  elsif p_kind = 'generate' then
    update public.profiles set generate_count = greatest(generate_count - 1, 0) where id = p_user;
  end if;
end $$;

-- Only the service role (edge functions) may call these.
revoke execute on function public.use_quota(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.refund_quota(uuid, text) from public, anon, authenticated;
grant  execute on function public.use_quota(uuid, text, int, int) to service_role;
grant  execute on function public.refund_quota(uuid, text) to service_role;
