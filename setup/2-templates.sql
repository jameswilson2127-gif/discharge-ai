-- Custom discharge-summary templates, one row per template, private to each user.
-- Templates hold FORMAT only (headings, phrasing, field labels) — never patient data.

create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  data        jsonb not null check (octet_length(data::text) < 60000),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists templates_user_idx on public.templates (user_id);

alter table public.templates enable row level security;

drop policy if exists "own templates: read"   on public.templates;
drop policy if exists "own templates: insert" on public.templates;
drop policy if exists "own templates: update" on public.templates;
drop policy if exists "own templates: delete" on public.templates;
create policy "own templates: read"   on public.templates for select using (auth.uid() = user_id);
create policy "own templates: insert" on public.templates for insert with check (auth.uid() = user_id);
create policy "own templates: update" on public.templates for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own templates: delete" on public.templates for delete using (auth.uid() = user_id);

-- Max 20 templates per user; only one default; keep updated_at fresh.
create or replace function public.templates_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.templates where user_id = new.user_id) >= 20 then
    raise exception 'You can save up to 20 templates.';
  end if;
  if new.is_default then
    update public.templates set is_default = false
     where user_id = new.user_id and id <> new.id and is_default;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists templates_guard on public.templates;
create trigger templates_guard
  before insert or update on public.templates
  for each row execute function public.templates_guard();

grant select, insert, update, delete on public.templates to authenticated;
