-- Run once in Supabase SQL Editor. Creates a public bucket for storefront images.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;
