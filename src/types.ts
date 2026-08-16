export type CategoryType = 'asset' | 'income' | 'expense' | 'investment'

export interface FinancialCategory {
  id: string
  user_id: string
  category_type: CategoryType
  name: string
  sort_order: number
}

export interface MonthlyRecord {
  id: string
  user_id: string
  category_id: string
  period: string
  amount: number
  note: string | null
  source: string
  financial_categories?: Pick<FinancialCategory, 'name' | 'category_type'> | null
}

export interface LedgerEntry {
  id: string
  user_id: string
  category_id: string
  entry_date: string
  period: string
  amount: number
  description: string
  source_type: 'manual' | 'google_sheets'
  source_sheet: string | null
  source_cell: string | null
  source_formula: string | null
  external_key: string | null
  created_at?: string
  updated_at?: string
  financial_categories?: Pick<FinancialCategory, 'name' | 'category_type'> | null
}

export interface HistoryFile {
  source: {
    spreadsheet_id: string
    title: string
    years: number[]
  }
  categories: Array<{
    type: CategoryType
    name: string
    sort_order: number
  }>
  records: Array<{
    period: string
    type: CategoryType
    category: string
    amount: number
    source_sheet: string
    source_row: number
  }>
  entries?: Array<{
    period: string
    entry_date: string
    type: CategoryType
    category: string
    amount: number
    description: string
    source_sheet: string
    source_cell: string
    source_formula: string | null
    component_index: number
    external_key: string
  }>
}
