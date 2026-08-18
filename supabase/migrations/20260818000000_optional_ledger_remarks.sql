-- Ledger remarks are optional: an imported cell only has a remark when the
-- source spreadsheet carried a note for it. Entries without one stay blank
-- instead of repeating their category name.

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.worthdelta_ledger_entries'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%description%'
  loop
    execute format('alter table public.worthdelta_ledger_entries drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.worthdelta_ledger_entries
  add constraint worthdelta_ledger_entries_description_length
  check (char_length(description) <= 200);

alter table public.worthdelta_ledger_entries
  alter column description set default '';
