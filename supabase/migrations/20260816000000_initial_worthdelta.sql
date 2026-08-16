create extension if not exists "pgcrypto";

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  currency text not null default 'MYR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_type text not null check (category_type in ('asset', 'income', 'expense', 'investment')),
  name text not null check (char_length(trim(name)) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, category_type, name),
  unique (user_id, id)
);

create table public.monthly_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null,
  period date not null check (period = date_trunc('month', period)::date),
  amount numeric(16, 2) not null,
  note text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category_id, period),
  foreign key (user_id, category_id)
    references public.financial_categories(user_id, id) on delete cascade
);

create index monthly_records_user_period_idx
  on public.monthly_records(user_id, period desc);
create index financial_categories_user_type_idx
  on public.financial_categories(user_id, category_type, sort_order);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger monthly_records_set_updated_at
before update on public.monthly_records
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.financial_categories enable row level security;
alter table public.monthly_records enable row level security;

create policy "Users can view their profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "Users can update their profile"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can view their categories"
on public.financial_categories for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their categories"
on public.financial_categories for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their categories"
on public.financial_categories for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their categories"
on public.financial_categories for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view their records"
on public.monthly_records for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their records"
on public.monthly_records for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their records"
on public.monthly_records for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their records"
on public.monthly_records for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.financial_categories to authenticated;
grant select, insert, update, delete on public.monthly_records to authenticated;
