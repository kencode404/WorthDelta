-- WorthDelta database setup, complete and idempotent.
--
-- Run this once on a new Supabase project, or against an existing one to bring
-- it up to date. Every statement is guarded, so running it twice changes
-- nothing. It replaces the incremental migrations that came before it.
--
-- Every object is prefixed worthdelta_ so this schema can share a project with
-- other apps.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tables

create table if not exists public.worthdelta_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  currency text not null default 'MYR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- main groups: 'expense' holds planned/unplanned, 'asset' holds current/non-current
create table if not exists public.worthdelta_expense_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  sort_order integer not null default 0,
  category_type text not null default 'expense',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table if not exists public.worthdelta_financial_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_type text not null check (category_type in ('asset', 'income', 'expense', 'investment')),
  name text not null check (char_length(trim(name)) between 1 and 100),
  icon text check (icon is null or char_length(icon) between 1 and 12),
  sort_order integer not null default 0,
  expense_group_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, category_type, name),
  unique (user_id, id)
);

create table if not exists public.worthdelta_monthly_records (
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

create table if not exists public.worthdelta_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null,
  entry_date date not null,
  period date not null check (period = date_trunc('month', period)::date),
  amount numeric(16, 2) not null,
  description text not null default '',
  source_type text not null default 'manual'
    check (source_type in ('manual', 'google_sheets')),
  source_sheet text,
  source_cell text,
  source_formula text,
  external_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_key),
  foreign key (user_id, category_id)
    references public.worthdelta_financial_categories(user_id, id) on delete cascade
);

-- columns added after the tables first shipped, for databases already in use
alter table public.worthdelta_expense_groups
  add column if not exists category_type text not null default 'expense';
alter table public.worthdelta_financial_categories
  add column if not exists expense_group_id uuid;
alter table public.worthdelta_financial_categories
  add column if not exists archived_at timestamptz;
-- an optional emoji, so a category is recognisable before its name is read
alter table public.worthdelta_financial_categories
  add column if not exists icon text;
-- salted hash of the app-lock PIN, so the lock follows the account rather than
-- one browser's local storage
alter table public.worthdelta_profiles
  add column if not exists lock_pin text;

-- ----------------------------------------------------------- constraints

do $$
begin
  -- group names only have to be unique within their own category type
  alter table public.worthdelta_expense_groups
    drop constraint if exists worthdelta_expense_groups_user_id_name_key;

  if not exists (select 1 from pg_constraint where conname = 'worthdelta_expense_groups_category_type_check') then
    alter table public.worthdelta_expense_groups
      add constraint worthdelta_expense_groups_category_type_check
      check (category_type in ('expense', 'asset'));
  end if;

  -- an emoji or two, never a second name: the chip has no room to grow
  if not exists (select 1 from pg_constraint where conname = 'worthdelta_financial_categories_icon_check') then
    alter table public.worthdelta_financial_categories
      add constraint worthdelta_financial_categories_icon_check
      check (icon is null or char_length(icon) between 1 and 12);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'worthdelta_financial_categories_expense_group_fk') then
    alter table public.worthdelta_financial_categories
      add constraint worthdelta_financial_categories_expense_group_fk
      foreign key (user_id, expense_group_id)
      references public.worthdelta_expense_groups(user_id, id);
  end if;
end $$;

create unique index if not exists worthdelta_expense_groups_user_type_name_key
  on public.worthdelta_expense_groups (user_id, category_type, name);

-- expenses must sit in a group, assets may, income and investments must not
do $$
begin
  alter table public.worthdelta_financial_categories
    drop constraint if exists worthdelta_financial_categories_expense_group_check;
  alter table public.worthdelta_financial_categories
    add constraint worthdelta_financial_categories_expense_group_check
    check (
      (category_type = 'expense' and expense_group_id is not null)
      or category_type = 'asset'
      or (category_type not in ('expense', 'asset') and expense_group_id is null)
    ) not valid;
end $$;

-- a remark is optional: an imported cell only has one when the sheet had a note
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.worthdelta_ledger_entries'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%description%'
  loop
    execute format('alter table public.worthdelta_ledger_entries drop constraint %I', constraint_name);
  end loop;

  alter table public.worthdelta_ledger_entries
    add constraint worthdelta_ledger_entries_description_length
    check (char_length(description) <= 200);
  alter table public.worthdelta_ledger_entries
    alter column description set default '';
end $$;

-- ---------------------------------------------------------------- indexes

create index if not exists worthdelta_monthly_records_user_period_idx
  on public.worthdelta_monthly_records(user_id, period desc);
create index if not exists worthdelta_financial_categories_user_type_idx
  on public.worthdelta_financial_categories(user_id, category_type, sort_order);
create index if not exists worthdelta_financial_categories_active_idx
  on public.worthdelta_financial_categories(user_id, category_type, archived_at);
create index if not exists worthdelta_financial_categories_expense_group_idx
  on public.worthdelta_financial_categories(user_id, expense_group_id, sort_order);
create index if not exists worthdelta_expense_groups_user_order_idx
  on public.worthdelta_expense_groups(user_id, sort_order, name);
create index if not exists worthdelta_ledger_entries_user_date_idx
  on public.worthdelta_ledger_entries(user_id, entry_date desc, created_at desc);
create index if not exists worthdelta_ledger_entries_user_period_idx
  on public.worthdelta_ledger_entries(user_id, period, category_id);

-- -------------------------------------------------------------- functions

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

-- a category may only sit in a group of its own type
create or replace function public.worthdelta_group_type_matches()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.expense_group_id is not null then
    if not exists (
      select 1 from public.worthdelta_expense_groups g
      where g.id = new.expense_group_id
        and g.user_id = new.user_id
        and g.category_type = new.category_type
    ) then
      raise exception 'group % is not a % group', new.expense_group_id, new.category_type;
    end if;
  end if;
  return new;
end;
$$;

-- a new sign-in gets a profile and the four default groups. The conflict target
-- must match the unique index, which is per category type.
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
  )
  on conflict (id) do nothing;

  insert into public.worthdelta_expense_groups (user_id, name, sort_order, category_type)
  values
    (new.id, 'Planned', 0, 'expense'),
    (new.id, 'Unplanned', 1, 'expense'),
    (new.id, 'Current', 0, 'asset'),
    (new.id, 'Non-current', 1, 'asset')
  on conflict (user_id, category_type, name) do nothing;

  return new;
end;
$$;

-- --------------------------------------------------------------- triggers

drop trigger if exists worthdelta_profiles_set_updated_at on public.worthdelta_profiles;
create trigger worthdelta_profiles_set_updated_at
before update on public.worthdelta_profiles
for each row execute function public.worthdelta_set_updated_at();

drop trigger if exists worthdelta_monthly_records_set_updated_at on public.worthdelta_monthly_records;
create trigger worthdelta_monthly_records_set_updated_at
before update on public.worthdelta_monthly_records
for each row execute function public.worthdelta_set_updated_at();

drop trigger if exists worthdelta_expense_groups_set_updated_at on public.worthdelta_expense_groups;
create trigger worthdelta_expense_groups_set_updated_at
before update on public.worthdelta_expense_groups
for each row execute function public.worthdelta_set_updated_at();

drop trigger if exists worthdelta_ledger_entries_set_updated_at on public.worthdelta_ledger_entries;
create trigger worthdelta_ledger_entries_set_updated_at
before update on public.worthdelta_ledger_entries
for each row execute function public.worthdelta_set_updated_at();

drop trigger if exists worthdelta_financial_categories_group_type on public.worthdelta_financial_categories;
create trigger worthdelta_financial_categories_group_type
before insert or update of expense_group_id, category_type
on public.worthdelta_financial_categories
for each row execute function public.worthdelta_group_type_matches();

drop trigger if exists worthdelta_on_auth_user_created on auth.users;
create trigger worthdelta_on_auth_user_created
after insert on auth.users
for each row execute function public.worthdelta_handle_new_user();

-- ------------------------------------------------------ row level security

alter table public.worthdelta_profiles enable row level security;
alter table public.worthdelta_expense_groups enable row level security;
alter table public.worthdelta_financial_categories enable row level security;
alter table public.worthdelta_monthly_records enable row level security;
alter table public.worthdelta_ledger_entries enable row level security;

-- every table is scoped to the signed-in user, on all four verbs
do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('worthdelta_profiles', 'profile', 'id'),
      ('worthdelta_expense_groups', 'expense groups', 'user_id'),
      ('worthdelta_financial_categories', 'categories', 'user_id'),
      ('worthdelta_monthly_records', 'records', 'user_id'),
      ('worthdelta_ledger_entries', 'ledger entries', 'user_id')
    ) as t(table_name, label, owner_column)
  loop
    execute format('drop policy if exists %I on public.%I', 'Users can view their ' || target.label, target.table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = %I)',
      'Users can view their ' || target.label, target.table_name, target.owner_column);

    execute format('drop policy if exists %I on public.%I', 'Users can update their ' || target.label, target.table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = %I) with check ((select auth.uid()) = %I)',
      'Users can update their ' || target.label, target.table_name, target.owner_column, target.owner_column);

    -- a profile row is created by the sign-up trigger, never by the client
    if target.table_name <> 'worthdelta_profiles' then
      execute format('drop policy if exists %I on public.%I', 'Users can create their ' || target.label, target.table_name);
      execute format(
        'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = %I)',
        'Users can create their ' || target.label, target.table_name, target.owner_column);

      execute format('drop policy if exists %I on public.%I', 'Users can delete their ' || target.label, target.table_name);
      execute format(
        'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = %I)',
        'Users can delete their ' || target.label, target.table_name, target.owner_column);
    end if;
  end loop;
end $$;

grant select, update on public.worthdelta_profiles to authenticated;
grant select, insert, update, delete on public.worthdelta_expense_groups to authenticated;
grant select, insert, update, delete on public.worthdelta_financial_categories to authenticated;
grant select, insert, update, delete on public.worthdelta_monthly_records to authenticated;
grant select, insert, update, delete on public.worthdelta_ledger_entries to authenticated;

-- ------------------------------------------------------------- seed groups

-- profiles that predate a group set get one, without disturbing existing groups
insert into public.worthdelta_expense_groups (user_id, name, sort_order, category_type)
select profile.id, defaults.name, defaults.sort_order, defaults.category_type
from public.worthdelta_profiles profile
cross join (values
  ('Planned', 0, 'expense'),
  ('Unplanned', 1, 'expense'),
  ('Current', 0, 'asset'),
  ('Non-current', 1, 'asset')
) as defaults(name, sort_order, category_type)
on conflict (user_id, category_type, name) do nothing;

notify pgrst, 'reload schema';

commit;
