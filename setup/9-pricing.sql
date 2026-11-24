-- One-time Pro payments (Razorpay Orders) with prices editable in admin. Run once, after files 1–8.
-- Prices live in app_settings.data.pricing (rupees, inclusive of taxes):
--   { offer_label, offer_ends (YYYY-MM-DD or null), monthly: {list, price, days}, yearly: {list, price, days} }

update public.app_settings set data = data || jsonb_build_object('pricing', jsonb_build_object(
  'offer_label', 'Launch offer', 'offer_ends', null,
  'monthly', jsonb_build_object('list', 999,  'price', 599,  'days', 30),
  'yearly',  jsonb_build_object('list', 9999, 'price', 6999, 'days', 365)))
where id = 1 and not (data ? 'pricing');

-- Prices are public (shown on the home page), so expose them with the free limit.
create or replace function public.public_limits()
returns jsonb language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'free_extract', coalesce((data->>'free_extract')::int, 5),
    'pro_extract',  coalesce((data->>'pro_extract')::int, 300),
    'pricing',      data->'pricing')
  from public.app_settings where id = 1
$$;

-- Orders: one row per checkout attempt. Only verified, paid orders are copied into payments
-- (so revenue figures never include abandoned checkouts).
create table if not exists public.orders (
  order_id     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  plan         text not null check (plan in ('monthly', 'yearly')),
  amount_paise int  not null,
  days         int  not null,
  status       text not null default 'created' check (status in ('created', 'paid')),
  payment_id   text,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);
create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
alter table public.orders enable row level security;   -- service role only

-- Marks an order paid and extends Pro exactly once (safe to call from both the app and the webhook).
create or replace function public.grant_pro_for_order(p_order text, p_payment text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare o public.orders; until timestamptz;
begin
  select * into o from public.orders where order_id = p_order for update;
  if not found then raise exception 'unknown order'; end if;
  if o.status = 'paid' then
    select pro_until into until from public.profiles where id = o.user_id;
    return until;
  end if;
  update public.orders set status = 'paid', payment_id = p_payment, paid_at = now() where order_id = p_order;
  insert into public.payments (user_id, razorpay_payment_id, plan, amount_paise)
  values (o.user_id, p_payment, o.plan, o.amount_paise) on conflict (razorpay_payment_id) do nothing;
  update public.profiles
     set pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => o.days),
         plan = o.plan
   where id = o.user_id
  returning pro_until into until;
  return until;
end $$;
revoke execute on function public.grant_pro_for_order(text, text) from public, anon, authenticated;
grant  execute on function public.grant_pro_for_order(text, text) to service_role;
