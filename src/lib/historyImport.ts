import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { FinancialCategory, HistoryFile } from '../types'

const CHUNK_SIZE = 250

export async function importHistory(file: File, user: User) {
  const payload = JSON.parse(await file.text()) as HistoryFile

  if (!payload.categories?.length || !payload.records?.length) {
    throw new Error('This file does not contain WorthDelta history data.')
  }

  const categoryRows = payload.categories.map((category) => ({
    user_id: user.id,
    category_type: category.type,
    name: category.name,
    sort_order: category.sort_order,
  }))

  const { error: categoryError } = await supabase
    .from('worthdelta_financial_categories')
    .upsert(categoryRows, { onConflict: 'user_id,category_type,name' })

  if (categoryError) throw categoryError

  const { data: categories, error: fetchError } = await supabase
    .from('worthdelta_financial_categories')
    .select('*')

  if (fetchError) throw fetchError

  const categoryMap = new Map(
    (categories as FinancialCategory[]).map((category) => [
      `${category.category_type}|${category.name}`,
      category.id,
    ]),
  )

  const rows = payload.records.map((record) => {
    const categoryId = categoryMap.get(`${record.type}|${record.category}`)
    if (!categoryId) throw new Error(`Category not found: ${record.category}`)

    return {
      user_id: user.id,
      category_id: categoryId,
      period: record.period,
      amount: record.amount,
      source: `Google Sheets · ${record.source_sheet}:${record.source_row}`,
    }
  })

  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const { error } = await supabase
      .from('worthdelta_monthly_records')
      .upsert(rows.slice(index, index + CHUNK_SIZE), {
        onConflict: 'user_id,category_id,period',
      })
    if (error) throw error
  }

  return { categories: categoryRows.length, records: rows.length }
}
