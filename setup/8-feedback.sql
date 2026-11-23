-- In-app feedback (👍/👎 + optional comment) and admin view. Run once, after files 1–7.
-- No patient data: the app asks doctors not to type any, and only stores rating + short comment.
create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rating     smallint not null check (rating in (-1, 1)),
  comment    text check (char_length(comment) <= 600),
  template   text check (char_length(template) <= 80),
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
drop policy if exists "feedback insert own" on public.feedback;
create policy "feedback insert own" on public.feedback for insert to authenticated with check (user_id = auth.uid());
-- (no select/update/delete policy: users can't read anyone's feedback; admin reads via the function below)

create or replace function public.admin_feedback(p_limit int)
returns jsonb language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'up',   (select count(*) from feedback where rating = 1),
    'down', (select count(*) from feedback where rating = -1),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('at', f.created_at, 'email', p.email, 'rating', f.rating,
                'comment', f.comment, 'template', f.template) order by f.created_at desc)
              from (select * from feedback order by created_at desc limit greatest(least(p_limit, 200), 1)) f
              left join profiles p on p.id = f.user_id), '[]'::jsonb))
$$;
revoke execute on function public.admin_feedback(int) from public, anon, authenticated;
grant  execute on function public.admin_feedback(int) to service_role;
