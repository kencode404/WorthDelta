import { useEffect, useMemo, useState } from 'react'
import { CaretDown, ChartLineUp, CheckCircle, Wallet } from '@phosphor-icons/react'
import { calculateXirr, combineCashFlowsByDate } from './lib/xirr'
import type { FinancialCategory, LedgerEntry, MonthlyRecord } from './types'

interface ReturnsViewProps {
  userId: string
  categories: FinancialCategory[]
  records: MonthlyRecord[]
  entries: LedgerEntry[]
  loading: boolean
}

interface InvestmentChoice {
  key: string
  name: string
  icon: string | null
  assetCategories: FinancialCategory[]
  investmentCategories: FinancialCategory[]
  archived: boolean
}

interface CashFlowDetail {
  id: string
  category: string
  description: string
  amount: number
}

interface CashFlowDay {
  date: string
  amount: number
  details: CashFlowDetail[]
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-MY', {
    style: 'currency',
    currency: 'MYR',
    maximumFractionDigits: 0,
  }).format(value)

const formatDate = (date: string) =>
  new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${date.slice(0, 10)}T00:00:00`),
  )

const localToday = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

const categoryKey = (name: string) => name.trim().toLocaleLowerCase('en')
const storageKey = (userId: string) => `worthdelta:xirr-categories:${userId}`

const readSelection = (userId: string) => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

const monthPeriod = (date: string) => `${date.slice(0, 7)}-01`

const formatPeriod = (start: string | null, end: string) => {
  if (!start) return '—'
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = new Date(`${end}T00:00:00`)
  const totalDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000))
  const totalMonths = Math.max(0, (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth())
  if (totalMonths === 0) return `${totalDays} ${totalDays === 1 ? 'day' : 'days'}`
  const years = Math.floor(totalMonths / 12)
  const months = totalMonths % 12
  if (years === 0) return `${months} ${months === 1 ? 'month' : 'months'}`
  if (months === 0) return `${years} ${years === 1 ? 'year' : 'years'}`
  return `${years}y ${months}m`
}

export function ReturnsView({ userId, categories, records, entries, loading }: ReturnsViewProps) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => readSelection(userId))
  const today = localToday()
  const currentPeriod = monthPeriod(today)

  const choices = useMemo<InvestmentChoice[]>(() => {
    const buckets = new Map<string, InvestmentChoice>()
    categories
      .filter((category) => category.category_type === 'asset' || category.category_type === 'investment')
      .forEach((category) => {
        const key = categoryKey(category.name)
        const existing = buckets.get(key) ?? {
          key,
          name: category.name,
          icon: category.icon ?? null,
          assetCategories: [],
          investmentCategories: [],
          archived: true,
        }
        if (!existing.icon && category.icon) existing.icon = category.icon
        if (category.category_type === 'asset') existing.assetCategories.push(category)
        else existing.investmentCategories.push(category)
        if (!category.archived_at) existing.archived = false
        buckets.set(key, existing)
      })
    return [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [categories])

  useEffect(() => {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(selectedKeys))
  }, [selectedKeys, userId])

  const selected = useMemo(() => choices.filter((choice) => selectedKeys.includes(choice.key)), [choices, selectedKeys])

  const currentValueByKey = useMemo(() => {
    const values = new Map<string, number>()
    selected.forEach((choice) => {
      const activeAssetIds = new Set(choice.assetCategories.filter((category) => !category.archived_at).map((category) => category.id))
      const latestByCategory = new Map<string, MonthlyRecord>()
      records
        .filter((record) => activeAssetIds.size > 0 && record.period <= currentPeriod && (
          activeAssetIds.has(record.category_id) ||
          (record.financial_categories?.category_type === 'asset' && categoryKey(record.financial_categories.name) === choice.key)
        ))
        .forEach((record) => {
          const existing = latestByCategory.get(record.category_id)
          if (!existing || record.period > existing.period) latestByCategory.set(record.category_id, record)
        })
      const total = [...latestByCategory.values()].reduce((sum, record) => sum + Number(record.amount), 0)
      values.set(choice.key, total)
    })
    return values
  }, [currentPeriod, records, selected])

  const rawFlows = useMemo(() => {
    const selectedNames = new Set(selected.map((choice) => choice.key))
    const selectedInvestmentIds = new Set(selected.flatMap((choice) => choice.investmentCategories.map((category) => category.id)))
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
    return entries
      .filter((entry) => entry.entry_date <= today && (
        selectedInvestmentIds.has(entry.category_id) ||
        (entry.financial_categories?.category_type === 'investment' && selectedNames.has(categoryKey(entry.financial_categories.name)))
      ))
      .map((entry): CashFlowDetail & { date: string } => ({
        id: entry.id,
        date: entry.entry_date,
        category: entry.financial_categories?.name ?? categoryNames.get(entry.category_id) ?? 'Investment',
        description: entry.description,
        // WorthDelta stores contributions as positive investment amounts. From
        // the investor's perspective they are negative; a negative withdrawal
        // becomes positive here.
        amount: -Number(entry.amount),
      }))
  }, [categories, entries, selected, today])

  const cashFlowDays = useMemo<CashFlowDay[]>(() => {
    const days = new Map<string, CashFlowDay>()
    rawFlows.forEach((flow) => {
      const day = days.get(flow.date) ?? { date: flow.date, amount: 0, details: [] }
      day.amount += flow.amount
      day.details.push(flow)
      days.set(flow.date, day)
    })
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [rawFlows])

  const currentValue = [...currentValueByKey.values()].reduce((sum, value) => sum + value, 0)
  const externalFlows = cashFlowDays.filter((flow) => Math.abs(flow.amount) > 0.005)
  const totalInvested = externalFlows.reduce((sum, flow) => sum + (flow.amount < 0 ? -flow.amount : 0), 0)
  const totalWithdrawn = externalFlows.reduce((sum, flow) => sum + (flow.amount > 0 ? flow.amount : 0), 0)
  const profitLoss = currentValue + totalWithdrawn - totalInvested
  const totalReturn = totalInvested > 0 ? profitLoss / totalInvested : null
  const xirrFlows = combineCashFlowsByDate([
    ...externalFlows.map(({ date, amount }) => ({ date, amount })),
    ...(currentValue > 0 ? [{ date: today, amount: currentValue }] : []),
  ])
  const xirr = calculateXirr(xirrFlows)
  const firstFlowDate = externalFlows[0]?.date ?? null
  const hasValueMapping = selected.every((choice) => choice.assetCategories.length > 0)
  const hasFlowMapping = selected.every((choice) => choice.investmentCategories.length > 0)

  const toggleChoice = (key: string) => {
    setSelectedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
  }

  return (
    <div className="returns-page">
      <section className="panel returns-selector" aria-labelledby="included-investments-title">
        <div className="returns-section-heading">
          <div><p className="eyebrow">Portfolio scope</p><h2 id="included-investments-title">Included Investments</h2><p>Select only the categories that belong in this return. Same-named asset balances supply current value, while investment entries supply dated cash flows. Your choice stays on this device.</p></div>
          {selected.length > 0 && <button className="returns-clear" type="button" onClick={() => setSelectedKeys([])}>Clear selection</button>}
        </div>
        {loading ? <p className="returns-empty">Loading categories…</p> : choices.length === 0 ? <p className="returns-empty">No asset or investment categories are available yet.</p> : <div className="returns-choice-grid">
          {choices.map((choice) => {
            const checked = selectedKeys.includes(choice.key)
            const value = currentValueByKey.get(choice.key)
            return <label className={`returns-choice ${checked ? 'selected' : ''}`} key={choice.key}>
              <input type="checkbox" checked={checked} onChange={() => toggleChoice(choice.key)} />
              <span className="returns-choice-icon" aria-hidden="true">{choice.icon ?? <ChartLineUp weight="duotone" />}</span>
              <span className="returns-choice-copy"><strong>{choice.name}</strong><small>{checked && value !== undefined ? formatCurrency(value) : choice.archived ? 'Archived category' : choice.assetCategories.length > 0 ? 'Current value available' : 'Cash flows only'}</small></span>
              <CheckCircle className="returns-choice-check" weight="fill" aria-hidden="true" />
            </label>
          })}
        </div>}
      </section>

      <section className="returns-result-grid" aria-label="Investment return summary">
        <article className="returns-xirr-card">
          <span className="returns-metric-icon"><ChartLineUp weight="duotone" aria-hidden="true" /></span>
          <div><p>Annualised Return (XIRR)</p><strong>{xirr === null ? '—' : `${(xirr * 100).toFixed(1)}%`}</strong><small>{selected.length === 0 ? 'Choose at least one investment' : xirr === null ? 'Needs dated contributions and a positive ending value or withdrawal' : 'Money-weighted annual return'}</small></div>
        </article>
        <div className="returns-metrics">
          <article><span>Total Invested</span><strong>{formatCurrency(totalInvested)}</strong><small>External contributions</small></article>
          <article><span>Current Value</span><strong>{formatCurrency(currentValue)}</strong><small>{selected.length} selected {selected.length === 1 ? 'category' : 'categories'}</small></article>
          <article className={profitLoss < 0 ? 'negative' : ''}><span>Profit / Loss</span><strong>{profitLoss >= 0 ? '+' : '−'}{formatCurrency(Math.abs(profitLoss))}</strong><small>Value + withdrawals − invested</small></article>
          <article className={totalReturn !== null && totalReturn < 0 ? 'negative' : ''}><span>Total Return</span><strong>{totalReturn === null ? '—' : `${totalReturn >= 0 ? '+' : '−'}${Math.abs(totalReturn * 100).toFixed(1)}%`}</strong><small>Not annualised</small></article>
          <article><span>Investing Period</span><strong>{formatPeriod(firstFlowDate, today)}</strong><small>{firstFlowDate ? `${formatDate(firstFlowDate)} – today` : 'No included cash flow yet'}</small></article>
        </div>
      </section>

      {selected.length > 0 && (!hasValueMapping || !hasFlowMapping) && <section className="returns-mapping-note" role="status"><Wallet weight="duotone" aria-hidden="true" /><p>{!hasValueMapping && !hasFlowMapping ? 'Some selections do not have both a same-named asset balance and investment cash-flow category.' : !hasValueMapping ? 'Some selections have cash flows but no same-named asset balance, so their current value is RM0.' : 'Some selections have an asset balance but no same-named investment cash-flow category.'} WorthDelta never substitutes the rest of your net worth.</p></section>}

      <details className="panel returns-cash-flows">
        <summary><span><CaretDown weight="bold" aria-hidden="true" /><strong>Cash Flows</strong></span><small>{cashFlowDays.length} dated {cashFlowDays.length === 1 ? 'flow' : 'flows'} + current value</small></summary>
        <div className="returns-flow-list">
          {cashFlowDays.length === 0 && currentValue === 0 ? <p className="returns-empty">Select investments with itemised investment entries to see their dated cash flows.</p> : <>
            {cashFlowDays.map((flow) => <article className={`returns-flow-row ${Math.abs(flow.amount) <= 0.005 ? 'net-zero' : flow.amount > 0 ? 'positive' : 'negative'}`} key={flow.date}>
              <div className="returns-flow-date"><strong>{formatDate(flow.date)}</strong><small>{Math.abs(flow.amount) <= 0.005 ? 'Net-zero activity · excluded from XIRR' : flow.amount > 0 ? 'Money leaving investment pool' : 'Money entering investment pool'}</small></div>
              <div className="returns-flow-details">{flow.details.map((detail) => <span key={detail.id}><b>{detail.category}</b>{detail.description && <small>{detail.description}</small>}<em>{detail.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(detail.amount))}</em></span>)}</div>
              <strong className="returns-flow-total">{flow.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(flow.amount))}</strong>
            </article>)}
            {currentValue > 0 && <article className="returns-flow-row final"><div className="returns-flow-date"><strong>{formatDate(today)}</strong><small>Final value used by XIRR</small></div><div className="returns-flow-details">{selected.map((choice) => <span key={choice.key}><b>{choice.name}</b><small>Latest selected asset value</small><em>+{formatCurrency(currentValueByKey.get(choice.key) ?? 0)}</em></span>)}</div><strong className="returns-flow-total">+{formatCurrency(currentValue)}</strong></article>}
          </>}
        </div>
      </details>
    </div>
  )
}
