-- 13 — "My Activity": a doctor's own discharges (last N days) and payments.
-- Only counts and dates; no patient data is stored on the server. Names shown in the app come
-- from the doctor's own phone (never uploaded).
create or replace function public.my_activity(p_days integer default 90)
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  ev as (
    select e.*,
      case when not e.ok or e.charged = false then 0
           when e.kind <> 'extract' then 0
           when coalesce(e.photos, 0) > 15 then 3
           when e.length = 'detailed' then 2
           else 1 end as units
    from usage_events e, me
    where e.user_id = me.uid and e.case_id is not null
      and e.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 90), 1), 365))
  ),
  c as (
    select case_id,
      min(created_at) as at,
      max(photos) filter (where kind = 'extract') as photos,
      (array_agg(length order by created_at desc) filter (where kind = 'extract' and ok))[1] as length,
      sum(units) as used,
      count(*) filter (where kind = 'extract' and ok and charged) as paid_reads,
      count(*) filter (where kind = 'extract' and ok and charged = false) as free_reads,
      count(*) filter (where kind = 'extract' and not ok) as failed_reads,
      count(*) filter (where kind = 'generate' and ok) as writes
    from ev group by case_id
  )
  select jsonb_build_object(
    'cases', coalesce((select jsonb_agg(jsonb_build_object(
        'case_id', case_id, 'at', at, 'photos', photos, 'length', length, 'used', used,
        'paid_reads', paid_reads, 'free_reads', free_reads, 'failed_reads', failed_reads, 'writes', writes)
        order by at desc) from c), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'at', y.created_at, 'plan', y.plan, 'amount_paise', y.amount_paise, 'days', o.days)
        order by y.created_at desc)
      from payments y left join orders o on o.payment_id = y.razorpay_payment_id, me
      where y.user_id = me.uid), '[]'::jsonb)
  )
$$;
revoke all on function public.my_activity(integer) from public, anon;
grant execute on function public.my_activity(integer) to authenticated;
