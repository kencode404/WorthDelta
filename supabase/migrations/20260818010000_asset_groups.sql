-- Main groups now cover assets as well as expenses, so asset categories can be
-- split into current and non-current. Liquidity = total assets - non-current.
-- The table keeps its worthdelta_expense_groups name to avoid re-pointing the
-- existing foreign key; category_type is what separates the two sets.

begin;

-- 20260817 pinned groups to expenses only:
--   (expense and group not null) or (not expense and group is null)
-- which rejects an asset carrying a group. Drop it before assigning anything.
alter table public.worthdelta_financial_categories
  drop constraint if exists worthdelta_financial_categories_expense_group_check;

alter table public.worthdelta_expense_groups
  add column if not exists category_type text not null default 'expense';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'worthdelta_expense_groups_category_type_check'
  ) then
    alter table public.worthdelta_expense_groups
      add constraint worthdelta_expense_groups_category_type_check
      check (category_type in ('expense', 'asset'));
  end if;
end $$;

-- group names only have to be unique within their own category type
alter table public.worthdelta_expense_groups
  drop constraint if exists worthdelta_expense_groups_user_id_name_key;

create unique index if not exists worthdelta_expense_groups_user_type_name_key
  on public.worthdelta_expense_groups (user_id, category_type, name);

insert into public.worthdelta_expense_groups (user_id, name, sort_order, category_type)
select profile.id, defaults.name, defaults.sort_order, 'asset'
from public.worthdelta_profiles profile
cross join (values ('Current', 0), ('Non-current', 1)) as defaults(name, sort_order)
on conflict (user_id, category_type, name) do nothing;

-- locked away until retirement or surrender: not liquid
update public.worthdelta_financial_categories category
set expense_group_id = asset_group.id
from public.worthdelta_expense_groups asset_group
where category.user_id = asset_group.user_id
  and asset_group.category_type = 'asset'
  and asset_group.name = 'Non-current'
  and category.category_type = 'asset'
  and (category.name like '%EPF%' or category.name like '%儲蓄險%' or category.name like '%投資型保單%');

-- everything else counts toward liquidity until you say otherwise in Settings
update public.worthdelta_financial_categories category
set expense_group_id = asset_group.id
from public.worthdelta_expense_groups asset_group
where category.user_id = asset_group.user_id
  and asset_group.category_type = 'asset'
  and asset_group.name = 'Current'
  and category.category_type = 'asset'
  and category.expense_group_id is null;

-- expenses still require a group; assets may have one; income and investments
-- must not. Assets stay permissive so an unassigned one is never a hard error.
alter table public.worthdelta_financial_categories
  add constraint worthdelta_financial_categories_expense_group_check
  check (
    (category_type = 'expense' and expense_group_id is not null)
    or category_type = 'asset'
    or (category_type not in ('expense', 'asset') and expense_group_id is null)
  );

-- a category must sit in a group of its own type
create or replace function public.worthdelta_group_type_matches()
returns trigger language plpgsql as $$
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
end $$;

drop trigger if exists worthdelta_financial_categories_group_type
  on public.worthdelta_financial_categories;
create trigger worthdelta_financial_categories_group_type
before insert or update of expense_group_id, category_type
on public.worthdelta_financial_categories
for each row execute function public.worthdelta_group_type_matches();

commit;
