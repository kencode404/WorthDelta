create table if not exists public.worthdelta_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null,
  entry_date date not null,
  period date not null check (period = date_trunc('month', period)::date),
  amount numeric(16, 2) not null,
  description text not null check (char_length(trim(description)) between 1 and 200),
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

create index if not exists worthdelta_ledger_entries_user_date_idx
  on public.worthdelta_ledger_entries(user_id, entry_date desc, created_at desc);
create index if not exists worthdelta_ledger_entries_user_period_idx
  on public.worthdelta_ledger_entries(user_id, period, category_id);

create or replace trigger worthdelta_ledger_entries_set_updated_at
before update on public.worthdelta_ledger_entries
for each row execute function public.worthdelta_set_updated_at();

alter table public.worthdelta_ledger_entries enable row level security;

do $$
begin
  create policy "Users can view their ledger entries"
  on public.worthdelta_ledger_entries for select to authenticated
  using ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can create their ledger entries"
  on public.worthdelta_ledger_entries for insert to authenticated
  with check ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can update their ledger entries"
  on public.worthdelta_ledger_entries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "Users can delete their ledger entries"
  on public.worthdelta_ledger_entries for delete to authenticated
  using ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete
  on public.worthdelta_ledger_entries to authenticated;
