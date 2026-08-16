begin;

-- Preserve any existing WorthDelta data while moving its tables into an
-- app-specific namespace within the shared public schema.
do $$
begin
  if to_regclass('public.worthdelta_profiles') is null
     and to_regclass('public.profiles') is not null then
    alter table public.profiles rename to worthdelta_profiles;
  end if;

  if to_regclass('public.worthdelta_financial_categories') is null
     and to_regclass('public.financial_categories') is not null then
    alter table public.financial_categories rename to worthdelta_financial_categories;
  end if;

  if to_regclass('public.worthdelta_monthly_records') is null
     and to_regclass('public.monthly_records') is not null then
    alter table public.monthly_records rename to worthdelta_monthly_records;
  end if;
end;
$$;

alter index if exists public.monthly_records_user_period_idx
  rename to worthdelta_monthly_records_user_period_idx;
alter index if exists public.financial_categories_user_type_idx
  rename to worthdelta_financial_categories_user_type_idx;

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

drop trigger if exists profiles_set_updated_at on public.worthdelta_profiles;
drop trigger if exists worthdelta_profiles_set_updated_at on public.worthdelta_profiles;
create trigger worthdelta_profiles_set_updated_at
before update on public.worthdelta_profiles
for each row execute function public.worthdelta_set_updated_at();

drop trigger if exists monthly_records_set_updated_at on public.worthdelta_monthly_records;
drop trigger if exists worthdelta_monthly_records_set_updated_at on public.worthdelta_monthly_records;
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

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists worthdelta_on_auth_user_created on auth.users;
create trigger worthdelta_on_auth_user_created
after insert on auth.users
for each row execute function public.worthdelta_handle_new_user();

drop function if exists public.handle_new_user();
drop function if exists public.set_updated_at();

notify pgrst, 'reload schema';

commit;
