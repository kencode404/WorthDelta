-- Deleting a category that already carries history would cascade its monthly
-- records and ledger entries away with it. Archiving keeps those past months
-- intact while retiring the category from everything going forward.

begin;

alter table public.worthdelta_financial_categories
  add column if not exists archived_at timestamptz;

create index if not exists worthdelta_financial_categories_active_idx
  on public.worthdelta_financial_categories(user_id, category_type, archived_at);

commit;
