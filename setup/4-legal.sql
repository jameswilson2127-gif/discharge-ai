-- Legal & compliance additions (run once in Supabase → SQL Editor, after files 1–3).
-- Records each user's acceptance of the Terms of Use / Privacy Policy and their
-- professional attestations, so you can show who agreed to what, and when.
-- Still no patient data anywhere in this database.

alter table public.profiles add column if not exists terms_version     int not null default 0;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists attestation       jsonb;

-- Append-only history of acceptances (kept even if the user later re-accepts a new version).
create table if not exists public.terms_acceptances (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete cascade,
  version      int not null,
  attestation  jsonb not null,
  accepted_at  timestamptz not null default now()
);
alter table public.terms_acceptances enable row level security;
drop policy if exists "read own acceptances" on public.terms_acceptances;
create policy "read own acceptances" on public.terms_acceptances for select using (auth.uid() = user_id);

-- Called from the app when the user ticks the boxes and accepts.
create or replace function public.accept_terms(p_version int, p_attest jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_version < 1 or p_version > 1000 then raise exception 'bad version'; end if;
  if octet_length(coalesce(p_attest, '{}'::jsonb)::text) > 2000 then raise exception 'too large'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  update public.profiles
     set terms_version = p_version, terms_accepted_at = now(), attestation = p_attest
   where id = auth.uid();
  insert into public.terms_acceptances (user_id, version, attestation) values (auth.uid(), p_version, p_attest);
end $$;

revoke execute on function public.accept_terms(int, jsonb) from public, anon;
grant  execute on function public.accept_terms(int, jsonb) to authenticated;
grant  select on public.terms_acceptances to authenticated;
grant  select, insert, update, delete on public.terms_acceptances to service_role;
grant  usage, select on sequence public.terms_acceptances_id_seq to service_role;
