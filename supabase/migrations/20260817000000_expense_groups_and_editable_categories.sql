begin;

create table if not exists public.worthdelta_expense_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name),
  unique (user_id, id)
);

alter table public.worthdelta_financial_categories
  add column if not exists expense_group_id uuid;

insert into public.worthdelta_expense_groups (user_id, name, sort_order)
select profile.id, defaults.name, defaults.sort_order
from public.worthdelta_profiles profile
cross join (values ('Planned', 0), ('Unplanned', 1)) as defaults(name, sort_order)
on conflict (user_id, name) do nothing;

update public.worthdelta_financial_categories category
set expense_group_id = expense_group.id
from public.worthdelta_expense_groups expense_group
where category.user_id = expense_group.user_id
  and category.category_type = 'expense'
  and expense_group.name = 'Planned'
  and category.name in (
    '房租+管理費/家用',
    '水費',
    '電費(每單月1次)',
    '電話費/網絡',
    '學貸',
    '貸款（車/房/其他）',
    '健身房',
    '訂閱服務',
    '保費(意外/醫療/車險)',
    '鋼琴課程'
  );

update public.worthdelta_financial_categories category
set expense_group_id = expense_group.id
from public.worthdelta_expense_groups expense_group
where category.user_id = expense_group.user_id
  and category.category_type = 'expense'
  and category.expense_group_id is null
  and expense_group.name = 'Unplanned';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'worthdelta_financial_categories_expense_group_fk'
  ) then
    alter table public.worthdelta_financial_categories
      add constraint worthdelta_financial_categories_expense_group_fk
      foreign key (user_id, expense_group_id)
      references public.worthdelta_expense_groups(user_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'worthdelta_financial_categories_expense_group_check'
  ) then
    alter table public.worthdelta_financial_categories
      add constraint worthdelta_financial_categories_expense_group_check
      check (
        (category_type = 'expense' and expense_group_id is not null)
        or (category_type <> 'expense' and expense_group_id is null)
      ) not valid;
  end if;
end;
$$;

alter table public.worthdelta_financial_categories
  validate constraint worthdelta_financial_categories_expense_group_check;

create index if not exists worthdelta_expense_groups_user_order_idx
  on public.worthdelta_expense_groups(user_id, sort_order, name);
create index if not exists worthdelta_financial_categories_expense_group_idx
  on public.worthdelta_financial_categories(user_id, expense_group_id, sort_order);

drop trigger if exists worthdelta_expense_groups_set_updated_at
  on public.worthdelta_expense_groups;
create trigger worthdelta_expense_groups_set_updated_at
before update on public.worthdelta_expense_groups
for each row execute function public.worthdelta_set_updated_at();

alter table public.worthdelta_expense_groups enable row level security;

do $$
begin
  create policy "Users can view their expense groups"
  on public.worthdelta_expense_groups for select to authenticated
  using ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can create their expense groups"
  on public.worthdelta_expense_groups for insert to authenticated
  with check ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can update their expense groups"
  on public.worthdelta_expense_groups for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can delete their expense groups"
  on public.worthdelta_expense_groups for delete to authenticated
  using ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete
  on public.worthdelta_expense_groups to authenticated;

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

  insert into public.worthdelta_expense_groups (user_id, name, sort_order)
  values
    (new.id, 'Planned', 0),
    (new.id, 'Unplanned', 1)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
