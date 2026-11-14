-- JUMIE order storage and safe, idempotent payment confirmation.
-- Confirm public.products has id, name, price, and stock columns before running.

create table if not exists public.jumie_orders (
  id uuid primary key default gen_random_uuid(),
  tx_ref text not null unique,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'NGN',
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  customer_state text not null,
  customer_city text not null,
  delivery_address text not null,
  flutterwave_transaction_id text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.jumie_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.jumie_orders(id) on delete cascade,
  product_id text not null,
  product_name text not null,
  unit_price numeric(12,2) not null check (unit_price > 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(12,2) not null check (line_total > 0)
);

create index if not exists jumie_orders_email_created_idx
  on public.jumie_orders (customer_email, created_at desc);
create index if not exists jumie_order_items_order_idx
  on public.jumie_order_items (order_id);

alter table public.jumie_orders enable row level security;
alter table public.jumie_order_items enable row level security;

create or replace function public.jumie_confirm_order(
  p_order_id uuid,
  p_transaction_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.jumie_orders%rowtype;
begin
  select * into v_order
  from public.jumie_orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('ok', true, 'already_paid', true);
  end if;
  if v_order.status <> 'pending' then raise exception 'Order is not pending'; end if;
  if not exists (select 1 from public.jumie_order_items where order_id = p_order_id) then
    raise exception 'Order has no items';
  end if;

  if exists (
    select 1
    from public.jumie_order_items i
    left join public.products p on p.id::text = i.product_id
    where i.order_id = p_order_id
      and (p.id is null or coalesce(p.stock, 0) < i.quantity)
  ) then
    raise exception 'Insufficient stock to confirm order';
  end if;

  update public.products p
  set stock = p.stock - i.quantity
  from public.jumie_order_items i
  where i.order_id = p_order_id and p.id::text = i.product_id;

  update public.jumie_orders
  set status = 'paid', flutterwave_transaction_id = p_transaction_id, paid_at = now()
  where id = p_order_id;

  return jsonb_build_object('ok', true, 'already_paid', false);
end;
$$;

revoke all on function public.jumie_confirm_order(uuid, text) from public, anon, authenticated;
grant execute on function public.jumie_confirm_order(uuid, text) to service_role;
