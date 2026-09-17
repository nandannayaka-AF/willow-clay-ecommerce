create or replace function public.create_order_with_stock(
  p_name text,
  p_email text,
  p_address text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id orders.id%type;
  v_item record;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item.' using errcode = 'P0001';
  end if;

  for v_item in
    with requested_items as (
      select
        (item ->> 'id')::bigint as product_id,
        (item ->> 'quantity')::integer as quantity
      from jsonb_array_elements(p_items) as item
    )
    select product_id, sum(quantity)::integer as quantity
    from requested_items
    group by product_id
    order by product_id
  loop
    if v_item.quantity < 1 then
      raise exception 'Order quantities must be at least 1.' using errcode = 'P0001';
    end if;

    perform 1
    from products
    where id = v_item.product_id
    for update;

    if not found then
      raise exception 'A product in this order no longer exists.' using errcode = 'P0001';
    end if;

    if (select stock from products where id = v_item.product_id) < v_item.quantity then
      raise exception 'One or more products do not have enough stock.' using errcode = 'P0001';
    end if;
  end loop;

  insert into orders (name, email, address)
  values (p_name, p_email, p_address)
  returning id into v_order_id;

  for v_item in
    with requested_items as (
      select
        (item ->> 'id')::bigint as product_id,
        (item ->> 'quantity')::integer as quantity
      from jsonb_array_elements(p_items) as item
    )
    select product_id, sum(quantity)::integer as quantity
    from requested_items
    group by product_id
  loop
    insert into order_items (order_id, product_id, quantity, price)
    select v_order_id, id, v_item.quantity, price
    from products
    where id = v_item.product_id;

    update products
    set stock = stock - v_item.quantity
    where id = v_item.product_id;
  end loop;

  return jsonb_build_object('order_id', v_order_id);
end;
$$;

revoke all on function public.create_order_with_stock(text, text, text, jsonb) from public;
grant execute on function public.create_order_with_stock(text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';