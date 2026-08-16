create extension if not exists "pgcrypto";

create table public.worthdelta_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  currency text not null default 'MYR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.worthdelta_financial_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_type text not null check (category_type in ('asset', 'income', 'expense', 'investment')),
  name text not null check (char_length(trim(name)) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, category_type, name),
  unique (user_id, id)
);

create table public.worthdelta_monthly_records (
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
    references public.worthdelta_financial_categories(user_id, id) on delete cascade
);

create index worthdelta_monthly_records_user_period_idx
  on public.worthdelta_monthly_records(user_id, period desc);
create index worthdelta_financial_categories_user_type_idx
  on public.worthdelta_financial_categories(user_id, category_type, sort_order);

create or replace function public.worthdelta_set_updated_at()
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

create trigger worthdelta_profiles_set_updated_at
before update on public.worthdelta_profiles
for each row execute function public.worthdelta_set_updated_at();

create trigger worthdelta_monthly_records_set_updated_at
before update on public.worthdelta_monthly_records
for each row execute function public.worthdelta_set_updated_at();

create or replace function public.worthdelta_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.worthdelta_profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger worthdelta_on_auth_user_created
after insert on auth.users
for each row execute function public.worthdelta_handle_new_user();

alter table public.worthdelta_profiles enable row level security;
alter table public.worthdelta_financial_categories enable row level security;
alter table public.worthdelta_monthly_records enable row level security;

create policy "Users can view their profile"
on public.worthdelta_profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "Users can update their profile"
on public.worthdelta_profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can view their categories"
on public.worthdelta_financial_categories for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their categories"
on public.worthdelta_financial_categories for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their categories"
on public.worthdelta_financial_categories for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their categories"
on public.worthdelta_financial_categories for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view their records"
on public.worthdelta_monthly_records for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their records"
on public.worthdelta_monthly_records for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their records"
on public.worthdelta_monthly_records for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their records"
on public.worthdelta_monthly_records for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, update on public.worthdelta_profiles to authenticated;
grant select, insert, update, delete on public.worthdelta_financial_categories to authenticated;
grant select, insert, update, delete on public.worthdelta_monthly_records to authenticated;
