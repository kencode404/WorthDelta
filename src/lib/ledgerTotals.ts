const totalKey = (categoryId: string, period: string) => `${categoryId}|${period}`

/**
 * Which totals to rewrite, and to what. Separated from the fetching so the rule
 * — add up the entries, unless the total was typed in — can be tested.
 */
export function ledgerTotalRows(
  userId: string,
  touched: Array<{ categoryId: string; period: string }>,
  records: Array<{ category_id: string; period: string; source: string }>,
  entries: Array<{ category_id: string; period: string; amount: number }>,
) {
  const existing = new Map(records.map((record) => [totalKey(record.category_id, record.period), record]))
  const sums = new Map<string, number>()
  entries.forEach((entry) => {
    const id = totalKey(entry.category_id, entry.period)
    sums.set(id, (sums.get(id) ?? 0) + Number(entry.amount))
  })

  return touched
    // A total the app has never built from entries is left alone: it was typed
    // in, and its figure is not ours to replace.
    .filter((pair) => {
      const record = existing.get(totalKey(pair.categoryId, pair.period))
      return !record || record.source === 'ledger'
    })
    .map((pair) => ({
      user_id: userId,
      category_id: pair.categoryId,
      period: pair.period,
      amount: Number((sums.get(totalKey(pair.categoryId, pair.period)) ?? 0).toFixed(2)),
      source: 'ledger',
    }))
}
