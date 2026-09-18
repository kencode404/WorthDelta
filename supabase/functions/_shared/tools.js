/**
 * What the server can be asked.
 *
 * These are the questions that came up over and over while working on the data
 * by hand: which totals no longer agree with their entries, what is in a
 * category for a month, where the negative amounts are. Each was a query
 * written out, pasted into the SQL editor, and read back from a screenshot.
 *
 * Every one of them reads. Nothing here writes, and the client it is attached
 * to cannot make it write.
 */

const money = (value) => Number(value ?? 0)
const round = (value) => Math.round(value * 100) / 100

/** period is stored as the first of the month; accept a bare 'YYYY-MM' too. */
const asPeriod = (value) => (value && value.length === 7 ? `${value}-01` : value)

/**
 * The tools, given a way to read.
 *
 * Nothing in here reaches for an environment. One server runs under node and
 * reads from process.env, the other under Deno inside a Supabase function; both
 * hand in a `select` and get back the same tools, so there is one copy of what
 * the questions mean rather than two that drift apart.
 */
export const createTools = ({ select, write = null, userId }) => {
  /** Adds the account filter when one is configured, so accounts cannot mix. */
  const scoped = (params = {}) => {
    const id = userId()
    return id ? { ...params, user_id: `eq.${id}` } : params
  }

  const categoriesById = async () => {
    const rows = await select('worthdelta_financial_categories', scoped({ select: 'id,name,category_type,archived_at,sort_order' }))
    return new Map(rows.map((row) => [row.id, row]))
  }

  return [
  {
    name: 'list_categories',
    description: 'List the financial categories, optionally of one type. Useful for finding the exact name or id a later call needs.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['asset', 'income', 'expense', 'investment'], description: 'Only categories of this type.' },
        include_archived: { type: 'boolean', description: 'Include retired categories. Defaults to false.' },
      },
    },
    async run({ type, include_archived: includeArchived = false }) {
      const rows = await select('worthdelta_financial_categories', scoped({ select: 'id,name,category_type,expense_group_id,archived_at,sort_order', order: 'category_type.asc,sort_order.asc' }))
      return rows
        .filter((row) => (type ? row.category_type === type : true))
        .filter((row) => (includeArchived ? true : !row.archived_at))
        .map(({ id, name, category_type, archived_at }) => ({ id, name, type: category_type, archived: Boolean(archived_at) }))
    },
  },

  {
    name: 'find_drifted_totals',
    description:
      "Find months where a category's recorded total no longer matches the entries beneath it. Only checks totals built from entries (source 'ledger'); a total typed in directly is allowed to differ and is skipped.",
    inputSchema: {
      type: 'object',
      properties: {
        tolerance: { type: 'number', description: 'Ignore differences smaller than this. Defaults to 0.01.' },
      },
    },
    async run({ tolerance = 0.01 }) {
      const [records, entries, categories] = await Promise.all([
        select('worthdelta_monthly_records', scoped({ select: 'id,category_id,period,amount,source' })),
        select('worthdelta_ledger_entries', scoped({ select: 'category_id,period,amount' })),
        categoriesById(),
      ])
      const sums = new Map()
      entries.forEach((entry) => {
        const key = `${entry.category_id}|${entry.period}`
        sums.set(key, (sums.get(key) ?? 0) + money(entry.amount))
      })
      return records
        .filter((record) => record.source === 'ledger')
        .map((record) => {
          const entriesTotal = sums.get(`${record.category_id}|${record.period}`) ?? 0
          return {
            record_id: record.id,
            category: categories.get(record.category_id)?.name ?? 'Unknown',
            type: categories.get(record.category_id)?.category_type ?? 'unknown',
            period: record.period,
            recorded_total: round(money(record.amount)),
            sum_of_entries: round(entriesTotal),
            difference: round(money(record.amount) - entriesTotal),
          }
        })
        .filter((row) => Math.abs(row.difference) >= tolerance)
        .sort((a, b) => a.period.localeCompare(b.period))
    },
  },

  {
    name: 'get_category_entries',
    description: 'The itemised entries for one category, optionally limited to a single month, with the recorded monthly total beside them for comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category name, matched case-insensitively.' },
        period: { type: 'string', description: "Month as 'YYYY-MM' or 'YYYY-MM-01'. Omit for every month." },
      },
      required: ['category'],
    },
    async run({ category, period }) {
      const categories = await categoriesById()
      const wanted = [...categories.values()].filter((row) => row.name.toLowerCase() === category.trim().toLowerCase())
      if (wanted.length === 0) throw new Error(`No category named "${category}".`)
      const ids = new Set(wanted.map((row) => row.id))
      const month = asPeriod(period)

      const [entries, records] = await Promise.all([
        select('worthdelta_ledger_entries', scoped({ select: 'id,category_id,entry_date,period,amount,description', order: 'entry_date.asc' })),
        select('worthdelta_monthly_records', scoped({ select: 'id,category_id,period,amount,source' })),
      ])
      const mine = entries.filter((entry) => ids.has(entry.category_id) && (month ? entry.period === month : true))
      const totals = records.filter((record) => ids.has(record.category_id) && (month ? record.period === month : true))

      return {
        // more than one means two categories share a name, which is its own problem
        categories: wanted.map(({ id, name, category_type }) => ({ id, name, type: category_type })),
        monthly_totals: totals.map(({ period: p, amount, source, id }) => ({ record_id: id, period: p, amount: round(money(amount)), source })),
        entries: mine.map(({ id, entry_date, period: p, amount, description }) => ({ id, entry_date, period: p, amount: round(money(amount)), description })),
        entries_total: round(mine.reduce((sum, entry) => sum + money(entry.amount), 0)),
      }
    },
  },

  {
    name: 'find_entries',
    description: 'Search the itemised entries by category type, sign and date range. Built for questions like "which investment entries are negative since April".',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['asset', 'income', 'expense', 'investment'] },
        sign: { type: 'string', enum: ['negative', 'positive', 'any'], description: "Defaults to 'any'." },
        from: { type: 'string', description: "Earliest entry_date, 'YYYY-MM-DD'." },
        to: { type: 'string', description: "Latest entry_date, 'YYYY-MM-DD'." },
        contains: { type: 'string', description: 'Only entries whose remark contains this text.' },
        limit: { type: 'number', description: 'Defaults to 200.' },
      },
    },
    async run({ type, sign = 'any', from, to, contains, limit = 200 }) {
      const [entries, categories] = await Promise.all([
        select('worthdelta_ledger_entries', scoped({ select: 'id,category_id,entry_date,period,amount,description', order: 'entry_date.asc' })),
        categoriesById(),
      ])
      const matched = entries.filter((entry) => {
        const category = categories.get(entry.category_id)
        if (type && category?.category_type !== type) return false
        if (sign === 'negative' && money(entry.amount) >= 0) return false
        if (sign === 'positive' && money(entry.amount) <= 0) return false
        if (from && entry.entry_date < from) return false
        if (to && entry.entry_date > to) return false
        if (contains && !(entry.description ?? '').toLowerCase().includes(contains.toLowerCase())) return false
        return true
      })
      return {
        matched: matched.length,
        total: round(matched.reduce((sum, entry) => sum + money(entry.amount), 0)),
        entries: matched.slice(0, limit).map((entry) => ({
          id: entry.id,
          entry_date: entry.entry_date,
          period: entry.period,
          category: categories.get(entry.category_id)?.name ?? 'Unknown',
          amount: round(money(entry.amount)),
          description: entry.description,
        })),
      }
    },
  },

  {
    name: 'get_monthly_totals',
    description: 'The recorded monthly totals, by category, for a month or a whole year. This is what the dashboard figures are built from.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: "A single month, 'YYYY-MM'." },
        year: { type: 'string', description: "A whole year, 'YYYY'." },
        type: { type: 'string', enum: ['asset', 'income', 'expense', 'investment'] },
      },
    },
    async run({ period, year, type }) {
      const month = asPeriod(period)
      const [records, categories] = await Promise.all([
        select('worthdelta_monthly_records', scoped({ select: 'id,category_id,period,amount,source', order: 'period.asc' })),
        categoriesById(),
      ])
      const matched = records.filter((record) => {
        const category = categories.get(record.category_id)
        if (type && category?.category_type !== type) return false
        if (month && record.period !== month) return false
        if (year && !record.period.startsWith(year)) return false
        return true
      })
      const byType = {}
      matched.forEach((record) => {
        const kind = categories.get(record.category_id)?.category_type ?? 'unknown'
        byType[kind] = round((byType[kind] ?? 0) + money(record.amount))
      })
      return {
        totals_by_type: byType,
        records: matched.map((record) => ({
          record_id: record.id,
          period: record.period,
          category: categories.get(record.category_id)?.name ?? 'Unknown',
          type: categories.get(record.category_id)?.category_type ?? 'unknown',
          amount: round(money(record.amount)),
          source: record.source,
        })),
      }
    },
  },

  {
    name: 'get_returns_scope',
    description: "The categories the Returns tab counts toward XIRR, as saved on the account. Two devices disagreeing on a return usually means this is empty or was never published.",
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const id = userId()
      const rows = await select('worthdelta_profiles', id ? { select: 'id,returns_scope', id: `eq.${id}` } : { select: 'id,returns_scope' })
      const categories = await categoriesById()
      const name = (categoryId) => categories.get(categoryId)?.name ?? categoryId
      return rows.map((row) => ({
        profile_id: row.id,
        saved: row.returns_scope != null,
        investments: (row.returns_scope?.investmentCategoryIds ?? []).map(name),
        assets: (row.returns_scope?.assetCategoryIds ?? []).map(name),
        dividends: (row.returns_scope?.dividendCategoryIds ?? []).map(name),
      }))
    },
  },

  // Only where a way to write was handed in. A server given none simply does
  // not have this tool, so there is nothing to ask it for.
  ...(write ? [{
    name: 'add_entry',
    description:
      "Record one entry in a category, the way the app's add form does. Adds the itemised entry and moves that month's total by the same amount. Refuses rather than guesses: the category must already exist and the date must be given. Does not edit or delete — use the app for that.",
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'An existing category name, matched case-insensitively.' },
        date: { type: 'string', description: "The date it happened, 'YYYY-MM-DD'. The month it counts toward comes from this." },
        amount: { type: 'number', description: 'May be negative — a refund, a correction, money taken back out.' },
        description: { type: 'string', description: 'The remark. Optional, up to 200 characters.' },
      },
      required: ['category', 'date', 'amount'],
    },
    async run({ category, date, amount, description = '' }) {
      const owner = userId()
      // Writing needs to know whose row this is, and there is nothing sensible
      // to fall back on. Better to refuse than to file it under a guess.
      if (!owner) throw new Error('Set WORTHDELTA_USER_ID before adding entries.')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Give the date as YYYY-MM-DD, not "${date}".`)
      if (!Number.isFinite(amount)) throw new Error('The amount must be a number.')
      if ((description ?? '').length > 200) throw new Error('A remark can be at most 200 characters.')

      const categories = await categoriesById()
      const matches = [...categories.values()].filter(
        (row) => row.name.toLowerCase() === category.trim().toLowerCase() && !row.archived_at,
      )
      if (matches.length === 0) throw new Error(`No category named "${category}". Use list_categories to see them.`)
      // Two categories of one name is a real state of this data, and picking
      // one at random would file the money somewhere arbitrary.
      if (matches.length > 1) throw new Error(`More than one category is named "${category}". Rename one before adding to it.`)
      const chosen = matches[0]
      const period = `${date.slice(0, 7)}-01`

      const entry = await write.insert('worthdelta_ledger_entries', {
        user_id: owner,
        category_id: chosen.id,
        entry_date: date,
        period,
        amount,
        description: (description ?? '').trim(),
        source_type: 'manual',
      })

      // The month's total is a row of its own. An entry added without moving it
      // is exactly the drift find_drifted_totals exists to catch, so it moves
      // here, the same way the app moves it.
      const existing = (await select('worthdelta_monthly_records', {
        select: 'id,amount',
        user_id: `eq.${owner}`,
        category_id: `eq.${chosen.id}`,
        period: `eq.${period}`,
      }))[0]

      const total = existing
        ? await write.update('worthdelta_monthly_records', { id: `eq.${existing.id}`, user_id: `eq.${owner}` }, { amount: round(money(existing.amount) + amount), source: 'ledger' })
        : await write.insert('worthdelta_monthly_records', { user_id: owner, category_id: chosen.id, period, amount: round(amount), source: 'ledger' })

      return {
        added: { id: entry?.id, category: chosen.name, entry_date: date, amount: round(amount), description: (description ?? '').trim() },
        month_total_now: round(money(total?.amount)),
        note: 'Check it in the app. Editing and deleting are not available here.',
      }
    },
  }] : []),
  ]
}
