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
}
