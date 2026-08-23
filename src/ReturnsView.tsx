import { useEffect, useMemo, useState } from 'react'
import { CaretDown, ChartLineUp, CheckCircle, Wallet } from '@phosphor-icons/react'
import { calculateXirr, combineCashFlowsByDate } from './lib/xirr'
import type { FinancialCategory, LedgerEntry, MonthlyRecord } from './types'

interface ReturnsViewProps { userId: string; categories: FinancialCategory[]; records: MonthlyRecord[]; entries: LedgerEntry[]; loading: boolean }
interface CashFlowDetail { id: string; category: string; description: string; amount: number; kind: 'opening' | 'investment' | 'dividend' }
interface CashFlowDay { date: string; amount: number; details: CashFlowDetail[] }
interface SavedScope { investmentCategoryIds: string[]; assetCategoryIds: string[]; dividendCategoryIds: string[] }

const formatCurrency = (value: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 0 }).format(value)
const formatDate = (date: string) => new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date.slice(0, 10)}T00:00:00`))
const categoryKey = (name: string) => name.trim().toLocaleLowerCase('en')
const scopeStorageKey = (userId: string) => `worthdelta:xirr-scope:${userId}`
const legacySelectionKey = (userId: string) => `worthdelta:xirr-categories:${userId}`
const monthPeriod = (date: string) => `${date.slice(0, 7)}-01`

const localToday = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

const readScope = (userId: string): SavedScope => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(scopeStorageKey(userId)) ?? '{}')
    return {
      investmentCategoryIds: Array.isArray(parsed.investmentCategoryIds) ? parsed.investmentCategoryIds.filter((value: unknown): value is string => typeof value === 'string') : [],
      assetCategoryIds: Array.isArray(parsed.assetCategoryIds) ? parsed.assetCategoryIds.filter((value: unknown): value is string => typeof value === 'string') : [],
      dividendCategoryIds: Array.isArray(parsed.dividendCategoryIds) ? parsed.dividendCategoryIds.filter((value: unknown): value is string => typeof value === 'string') : [],
    }
  } catch { return { investmentCategoryIds: [], assetCategoryIds: [], dividendCategoryIds: [] } }
}

const readLegacySelection = (userId: string) => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(legacySelectionKey(userId)) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch { return new Set<string>() }
}

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

function ScopeChoice({ category, checked, onToggle, kind }: { category: FinancialCategory; checked: boolean; onToggle: () => void; kind: 'flow' | 'value' | 'dividend' }) {
  return <label className={`returns-choice ${checked ? 'selected' : ''}`}>
    <input type="checkbox" checked={checked} onChange={onToggle} />
    <span className="returns-choice-icon" aria-hidden="true">{category.icon ?? (kind === 'value' ? <Wallet weight="duotone" /> : <ChartLineUp weight="duotone" />)}</span>
    <span className="returns-choice-copy"><strong>{category.name}</strong><small>{category.archived_at ? 'Archived category' : kind === 'flow' ? 'Dated cash flows' : kind === 'value' ? 'Opening and latest value' : 'Dated dividend income'}</small></span>
    <CheckCircle className="returns-choice-check" weight="fill" aria-hidden="true" />
  </label>
}

export function ReturnsView({ userId, categories, records, entries, loading }: ReturnsViewProps) {
  const initialScope = useState(() => readScope(userId))[0]
  const [selectedInvestmentIds, setSelectedInvestmentIds] = useState<string[]>(initialScope.investmentCategoryIds)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>(initialScope.assetCategoryIds)
  const [selectedDividendIds, setSelectedDividendIds] = useState<string[]>(initialScope.dividendCategoryIds)
  const today = localToday()
  const currentPeriod = monthPeriod(today)
  const currentYear = today.slice(0, 4)
  const [cashFlowYear, setCashFlowYear] = useState(currentYear)

  const investmentCategories = useMemo(() => categories.filter((category) => category.category_type === 'investment').sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), [categories])
  const assetCategories = useMemo(() => categories.filter((category) => category.category_type === 'asset').sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), [categories])
  const incomeCategories = useMemo(() => categories.filter((category) => category.category_type === 'income').sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), [categories])

  // Migrate the former name-based scope once; future selections use stable IDs.
  useEffect(() => {
    if (selectedInvestmentIds.length > 0 || selectedAssetIds.length > 0 || categories.length === 0) return
    const legacyNames = readLegacySelection(userId)
    if (legacyNames.size === 0) return
    setSelectedInvestmentIds(investmentCategories.filter((category) => legacyNames.has(categoryKey(category.name))).map((category) => category.id))
    setSelectedAssetIds(assetCategories.filter((category) => legacyNames.has(categoryKey(category.name))).map((category) => category.id))
  }, [assetCategories, categories.length, investmentCategories, selectedAssetIds.length, selectedInvestmentIds.length, userId])

  useEffect(() => { window.localStorage.setItem(scopeStorageKey(userId), JSON.stringify({ investmentCategoryIds: selectedInvestmentIds, assetCategoryIds: selectedAssetIds, dividendCategoryIds: selectedDividendIds })) }, [selectedAssetIds, selectedDividendIds, selectedInvestmentIds, userId])

  const selectedInvestments = useMemo(() => investmentCategories.filter((category) => selectedInvestmentIds.includes(category.id)), [investmentCategories, selectedInvestmentIds])
  const selectedAssets = useMemo(() => assetCategories.filter((category) => selectedAssetIds.includes(category.id)), [assetCategories, selectedAssetIds])
  const selectedDividends = useMemo(() => incomeCategories.filter((category) => selectedDividendIds.includes(category.id)), [incomeCategories, selectedDividendIds])

  const currentValueById = useMemo(() => {
    const values = new Map<string, number>()
    selectedAssets.forEach((category) => {
      if (category.archived_at) { values.set(category.id, 0); return }
      const matching = records.filter((record) => record.period <= currentPeriod && (record.category_id === category.id || (record.financial_categories?.category_type === 'asset' && categoryKey(record.financial_categories.name) === categoryKey(category.name)))).sort((a, b) => b.period.localeCompare(a.period))
      values.set(category.id, Number(matching[0]?.amount ?? 0))
    })
    return values
  }, [currentPeriod, records, selectedAssets])

  const rawFlows = useMemo(() => {
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
    const matchesSelected = (entry: LedgerEntry, selected: FinancialCategory[], type: 'investment' | 'income') => {
      const ids = new Set(selected.map((category) => category.id))
      const names = new Set(selected.map((category) => categoryKey(category.name)))
      return ids.has(entry.category_id) || (entry.financial_categories?.category_type === type && names.has(categoryKey(entry.financial_categories.name)))
    }
    const investmentFlows = entries.filter((entry) => entry.entry_date <= today && matchesSelected(entry, selectedInvestments, 'investment')).map((entry): CashFlowDetail & { date: string } => ({ id: entry.id, date: entry.entry_date, category: entry.financial_categories?.name ?? categoryNames.get(entry.category_id) ?? 'Investment', description: entry.description, amount: -Number(entry.amount), kind: 'investment' }))
    const dividendFlows = entries.filter((entry) => entry.entry_date <= today && matchesSelected(entry, selectedDividends, 'income')).map((entry): CashFlowDetail & { date: string } => ({ id: `dividend-${entry.id}`, date: entry.entry_date, category: entry.financial_categories?.name ?? categoryNames.get(entry.category_id) ?? 'Dividend income', description: entry.description || 'Dividend received', amount: Number(entry.amount), kind: 'dividend' }))
    const openingAssetFlows = selectedAssets.flatMap((category): Array<CashFlowDetail & { date: string }> => {
      const matching = records.filter((record) => record.period <= currentPeriod && (record.category_id === category.id || (record.financial_categories?.category_type === 'asset' && categoryKey(record.financial_categories.name) === categoryKey(category.name)))).sort((a, b) => a.period.localeCompare(b.period))
      const firstRecord = matching[0]
      if (!firstRecord || Number(firstRecord.amount) === 0) return []
      return [{ id: `opening-${firstRecord.id}`, date: firstRecord.period, category: category.name, description: 'Opening asset value', amount: -Number(firstRecord.amount), kind: 'opening' }]
    })
    return [...openingAssetFlows, ...investmentFlows, ...dividendFlows]
  }, [categories, currentPeriod, entries, records, selectedAssets, selectedDividends, selectedInvestments, today])

  const cashFlowDays = useMemo<CashFlowDay[]>(() => {
    const days = new Map<string, CashFlowDay>()
    rawFlows.forEach((flow) => { const day = days.get(flow.date) ?? { date: flow.date, amount: 0, details: [] }; day.amount += flow.amount; day.details.push(flow); days.set(flow.date, day) })
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [rawFlows])

  const currentValue = [...currentValueById.values()].reduce((sum, value) => sum + value, 0)
  const externalFlows = cashFlowDays.filter((flow) => Math.abs(flow.amount) > 0.005)
  const totalInvested = externalFlows.reduce((sum, flow) => sum + (flow.amount < 0 ? -flow.amount : 0), 0)
  const totalWithdrawn = externalFlows.reduce((sum, flow) => sum + (flow.amount > 0 ? flow.amount : 0), 0)
  const totalDividends = rawFlows.filter((flow) => flow.kind === 'dividend').reduce((sum, flow) => sum + flow.amount, 0)
  const netInvested = totalInvested - totalDividends
  const profitLoss = currentValue + totalWithdrawn - totalInvested
  const totalReturn = totalInvested > 0 ? profitLoss / totalInvested : null
  const xirr = calculateXirr(combineCashFlowsByDate([...externalFlows.map(({ date, amount }) => ({ date, amount })), ...(currentValue > 0 ? [{ date: today, amount: currentValue }] : [])]))
  const firstFlowDate = externalFlows[0]?.date ?? null
  const cashFlowYears = [...new Set([currentYear, ...cashFlowDays.map((flow) => flow.date.slice(0, 4))])].sort().reverse()
  const visibleCashFlowDays = cashFlowDays.filter((flow) => flow.date.slice(0, 4) === cashFlowYear).sort((a, b) => b.date.localeCompare(a.date))
  const showFinalValue = currentValue > 0 && cashFlowYear === currentYear
  const toggleSelection = (id: string, setSelection: React.Dispatch<React.SetStateAction<string[]>>) => setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])

  return <div className="returns-page">
    <details className="panel returns-selector" open>
      <summary><span><CaretDown weight="bold" aria-hidden="true" /><strong>Included Investments</strong></span><small>{selectedInvestments.length} investment · {selectedAssets.length} asset · {selectedDividends.length} dividend</small></summary>
      <div className="returns-selector-body">
        <div className="returns-section-heading"><div><p className="eyebrow">Portfolio scope</p><h2>Build your XIRR scope</h2><p>Choose investment cash flows, the Initial Asset opening and latest values, and optional dividend income. All choices stay on this device.</p></div>{(selectedInvestments.length > 0 || selectedAssets.length > 0 || selectedDividends.length > 0) && <button className="returns-clear" type="button" onClick={() => { setSelectedInvestmentIds([]); setSelectedAssetIds([]); setSelectedDividendIds([]) }}>Clear selection</button>}</div>
        {loading ? <p className="returns-empty">Loading categories…</p> : <div className="returns-scope-grid">
          <section className="returns-scope-section flow" aria-labelledby="xirr-flow-categories-title"><header><span className="returns-scope-icon"><ChartLineUp weight="duotone" aria-hidden="true" /></span><div><h3 id="xirr-flow-categories-title">Cash Flow Data</h3><p>Choose from Investment categories.</p></div></header>{investmentCategories.length === 0 ? <p className="returns-empty">No Investment categories yet.</p> : <div className="returns-choice-grid">{investmentCategories.map((category) => <ScopeChoice key={category.id} category={category} kind="flow" checked={selectedInvestmentIds.includes(category.id)} onToggle={() => toggleSelection(category.id, setSelectedInvestmentIds)} />)}</div>}</section>
          <section className="returns-scope-section value" aria-labelledby="xirr-value-categories-title"><header><span className="returns-scope-icon"><Wallet weight="duotone" aria-hidden="true" /></span><div><h3 id="xirr-value-categories-title">Current Latest Value</h3><p>Choose from Initial Assets categories.</p></div></header>{assetCategories.length === 0 ? <p className="returns-empty">No Initial Asset categories yet.</p> : <div className="returns-choice-grid">{assetCategories.map((category) => <ScopeChoice key={category.id} category={category} kind="value" checked={selectedAssetIds.includes(category.id)} onToggle={() => toggleSelection(category.id, setSelectedAssetIds)} />)}</div>}</section>
          <section className="returns-scope-section dividend" aria-labelledby="xirr-dividend-categories-title"><header><span className="returns-scope-icon"><ChartLineUp weight="duotone" aria-hidden="true" /></span><div><h3 id="xirr-dividend-categories-title">Dividend Income</h3><p>Optional: choose only dividend or distribution income.</p></div></header>{incomeCategories.length === 0 ? <p className="returns-empty">No Income categories yet.</p> : <div className="returns-choice-grid">{incomeCategories.map((category) => <ScopeChoice key={category.id} category={category} kind="dividend" checked={selectedDividendIds.includes(category.id)} onToggle={() => toggleSelection(category.id, setSelectedDividendIds)} />)}</div>}</section>
        </div>}
      </div>
    </details>

    <section className="returns-result-grid" aria-label="Investment return summary">
      <article className="returns-xirr-card"><span className="returns-metric-icon"><ChartLineUp weight="duotone" aria-hidden="true" /></span><div><p>Annualised Return (XIRR)</p><strong>{xirr === null ? '—' : `${(xirr * 100).toFixed(1)}%`}</strong><small>{selectedInvestments.length === 0 && selectedAssets.length === 0 ? 'Choose investment or Initial Asset categories' : xirr === null ? 'Needs dated contributions and a positive ending value or withdrawal' : 'Money-weighted annual return'}</small></div></article>
      <div className="returns-metrics"><article><span>Total Invested</span><strong>{formatCurrency(totalInvested)}</strong><small>Includes Initial Asset opening values</small></article><article><span>Net Invested</span><strong>{formatCurrency(netInvested)}</strong><small>Total invested − dividends {formatCurrency(totalDividends)}</small></article><article><span>Current Value</span><strong>{formatCurrency(currentValue)}</strong><small>{selectedAssets.length} selected {selectedAssets.length === 1 ? 'asset category' : 'asset categories'}</small></article><article className={profitLoss < 0 ? 'negative' : ''}><span>Profit / Loss</span><strong>{profitLoss >= 0 ? '+' : '−'}{formatCurrency(Math.abs(profitLoss))}</strong><small>Value + income − invested</small></article><article className={totalReturn !== null && totalReturn < 0 ? 'negative' : ''}><span>Total Return</span><strong>{totalReturn === null ? '—' : `${totalReturn >= 0 ? '+' : '−'}${Math.abs(totalReturn * 100).toFixed(1)}%`}</strong><small>Not annualised</small></article><article><span>Investing Period</span><strong>{formatPeriod(firstFlowDate, today)}</strong><small>{firstFlowDate ? `${formatDate(firstFlowDate)} – today` : 'No included cash flow yet'}</small></article></div>
    </section>

    <details className="panel returns-cash-flows"><summary><span><CaretDown weight="bold" aria-hidden="true" /><strong>Cash Flows</strong></span><small>{visibleCashFlowDays.length} {cashFlowYear} {visibleCashFlowDays.length === 1 ? 'flow' : 'flows'}{showFinalValue ? ' + current value' : ''}</small></summary><div className="returns-flow-list"><div className="returns-flow-toolbar"><p>Showing newest first. The XIRR above always uses the full selected history.</p><label><span>Year</span><select value={cashFlowYear} onChange={(event) => setCashFlowYear(event.target.value)}>{cashFlowYears.map((year) => <option key={year} value={year}>{year}{year === currentYear ? ' · Current' : ''}</option>)}</select></label></div>{visibleCashFlowDays.length === 0 && !showFinalValue ? <p className="returns-empty">No included cash flows in {cashFlowYear}.</p> : <>{visibleCashFlowDays.map((flow) => <article className={`returns-flow-row ${Math.abs(flow.amount) <= 0.005 ? 'net-zero' : flow.amount > 0 ? 'positive' : 'negative'}`} key={flow.date}><div className="returns-flow-date"><strong>{formatDate(flow.date)}</strong><small>{Math.abs(flow.amount) <= 0.005 ? 'Net-zero activity · excluded from XIRR' : flow.amount > 0 ? 'Money leaving investment pool' : 'Money entering investment pool'}</small></div><div className="returns-flow-details">{flow.details.map((detail) => <span key={detail.id}><b>{detail.category}</b>{detail.description && <small>{detail.description}</small>}<em>{detail.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(detail.amount))}</em></span>)}</div><strong className="returns-flow-total">{flow.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(flow.amount))}</strong></article>)}{showFinalValue && <article className="returns-flow-row final"><div className="returns-flow-date"><strong>{formatDate(today)}</strong><small>Final value used by XIRR</small></div><div className="returns-flow-details">{selectedAssets.map((category) => <span key={category.id}><b>{category.name}</b><small>Latest selected asset value</small><em>+{formatCurrency(currentValueById.get(category.id) ?? 0)}</em></span>)}</div><strong className="returns-flow-total">+{formatCurrency(currentValue)}</strong></article>}</>}</div></details>
  </div>
}
