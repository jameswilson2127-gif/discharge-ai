-- Summary length (Concise / Standard / Detailed) in usage records and the admin cost view.
-- Run once in Supabase → SQL Editor, after files 1–5.

alter table public.usage_events add column if not exists length text;

create or replace function public.admin_cases(p_limit int, p_offset int)
returns jsonb language sql security definer set search_path = public stable as $$
  with c as (
    select e.case_id,
           min(e.created_at)                                             as started_at,
           (array_agg(e.user_id))[1]                                     as user_id,
           max(e.photos) filter (where e.kind = 'extract')               as photos,
           max(e.length) filter (where e.kind = 'extract')               as length,
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
        'case_id', x.case_id, 'at', x.started_at, 'email', p.email, 'photos', x.photos, 'length', x.length,
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
                          from m group by 1) z), '[]'::jsonb),
      'by_length', coalesce((select jsonb_agg(jsonb_build_object('length', length, 'cases', n, 'avg_usd', a) order by n desc)
                  from (select coalesce(length, 'not recorded') as length, count(*) as n, avg(cost_usd) as a
                          from m group by 1) z), '[]'::jsonb))
  )
$$;

revoke execute on function public.admin_cases(int, int) from public, anon, authenticated;
grant  execute on function public.admin_cases(int, int) to service_role;
