-- Per-discharge and per-user AI cost (run once in Supabase → SQL Editor, after files 1–4).
-- Each new patient in the app gets a random case_id. Every AI call for that patient
-- (reading photos, writing, rewrites) is logged with it, so costs can be added up per discharge.
-- case_id is random and contains nothing about the patient.

alter table public.usage_events add column if not exists case_id uuid;
alter table public.usage_events add column if not exists photos  int;
create index if not exists usage_events_case_idx on public.usage_events (case_id) where case_id is not null;

-- List of discharges (newest first) + summary for the current month (IST).
create or replace function public.admin_cases(p_limit int, p_offset int)
returns jsonb language sql security definer set search_path = public stable as $$
  with c as (
    select e.case_id,
           min(e.created_at)                                             as started_at,
           (array_agg(e.user_id))[1]                                     as user_id,
           max(e.photos) filter (where e.kind = 'extract')               as photos,
           count(*) filter (where e.kind = 'extract' and e.ok)           as reads,
           count(*) filter (where e.kind = 'generate' and e.ok)          as drafts,
           count(*) filter (where not e.ok)                              as errors,
           coalesce(sum(e.cost_usd), 0)                                  as cost_usd,
           max(e.model) filter (where e.kind = 'extract')                as read_model,
           max(e.model) filter (where e.kind = 'generate')               as write_model
      from usage_events e
     where e.case_id is not null
     group by e.case_id
  ),
  m as (select * from c where (started_at at time zone 'Asia/Kolkata') >= date_trunc('month', now() at time zone 'Asia/Kolkata'))
  select jsonb_build_object(
    'total', (select count(*) from c),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'case_id', x.case_id, 'at', x.started_at, 'email', p.email, 'photos', x.photos,
        'reads', x.reads, 'drafts', x.drafts, 'errors', x.errors, 'cost_usd', x.cost_usd,
        'read_model', x.read_model, 'write_model', x.write_model) order by x.started_at desc)
      from (select * from c order by started_at desc
            limit greatest(least(p_limit, 100), 1) offset greatest(p_offset, 0)) x
      left join profiles p on p.id = x.user_id), '[]'::jsonb),
    'month', jsonb_build_object(
      'cases',    (select count(*) from m),
      'avg_usd',  (select coalesce(avg(cost_usd), 0) from m),
      'max_usd',  (select coalesce(max(cost_usd), 0) from m),
      'by_model', coalesce((select jsonb_agg(jsonb_build_object('model', read_model, 'cases', n, 'avg_usd', a) order by n desc)
                  from (select coalesce(read_model, 'unknown') as read_model, count(*) as n, avg(cost_usd) as a
                          from m group by 1) z), '[]'::jsonb))
  )
$$;

-- AI cost per user for the current month (IST), most expensive first.
create or replace function public.admin_user_costs(p_limit int, p_offset int)
returns jsonb language sql security definer set search_path = public stable as $$
  with u as (
    select e.user_id,
           count(*) filter (where e.kind = 'extract' and e.ok)  as discharges,
           count(*) filter (where e.kind = 'generate' and e.ok) as drafts,
           coalesce(sum(e.cost_usd), 0)                         as cost_usd
      from usage_events e
     where e.user_id is not null
       and (e.created_at at time zone 'Asia/Kolkata') >= date_trunc('month', now() at time zone 'Asia/Kolkata')
     group by e.user_id
  )
  select jsonb_build_object(
    'total', (select count(*) from u),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', x.user_id, 'email', p.email, 'plan', p.plan,
        'pro', (p.pro_until is not null and p.pro_until > now()),
        'discharges', x.discharges, 'drafts', x.drafts, 'cost_usd', x.cost_usd) order by x.cost_usd desc)
      from (select * from u order by cost_usd desc
            limit greatest(least(p_limit, 100), 1) offset greatest(p_offset, 0)) x
      left join profiles p on p.id = x.user_id), '[]'::jsonb)
  )
$$;

revoke execute on function public.admin_cases(int, int)      from public, anon, authenticated;
revoke execute on function public.admin_user_costs(int, int) from public, anon, authenticated;
grant  execute on function public.admin_cases(int, int)      to service_role;
grant  execute on function public.admin_user_costs(int, int) to service_role;
