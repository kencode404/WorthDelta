import { useEffect, useMemo, useState } from 'react'
import {
  Campfire,
  FlagCheckered,
  Info,
  MagicWand,
  Plus,
  Receipt,
  Sparkle,
  Trash,
} from '@phosphor-icons/react'
import type { FinancialCategory, MonthlyRecord } from './types'

type TargetMode = 'current' | 'ideal'

interface IdealBudget {
  enabled: boolean
  amount: number
}

interface CustomBudget extends IdealBudget {
  id: string
  name: string
}

interface FireSettings {
  nominalReturn: number
  inflation: number
  targetMode: TargetMode
  idealBudgets: Record<string, IdealBudget>
  customBudgets: CustomBudget[]
}

interface FirePlanProps {
  userId: string
  categories: FinancialCategory[]
  records: MonthlyRecord[]
  loading: boolean
}

const defaultSettings: FireSettings = {
  nominalReturn: 6,
  inflation: 3.5,
  targetMode: 'current',
  idealBudgets: {},
  customBudgets: [],
}

const chartColors = ['#228b22', '#2f6e9e', '#c46a3a', '#8064a2', '#c24d57', '#b08720', '#32887b']

const formatCurrency = (value: number) => new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: 'MYR',
  maximumFractionDigits: 0,
}).format(Number.isFinite(value) ? value : 0)

const formatMonth = (period: string) => new Intl.DateTimeFormat('en-MY', {
  month: 'short',
  year: 'numeric',
}).format(new Date(`${period.slice(0, 7)}-02T00:00:00`))

const currentPeriod = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
}

const readSettings = (key: string): FireSettings => {
  try {
    const saved = window.localStorage.getItem(key)
    if (!saved) return defaultSettings
    const parsed = JSON.parse(saved) as Partial<FireSettings>
    return {
      nominalReturn: Number.isFinite(parsed.nominalReturn) ? Number(parsed.nominalReturn) : defaultSettings.nominalReturn,
      inflation: Number.isFinite(parsed.inflation) ? Number(parsed.inflation) : defaultSettings.inflation,
      targetMode: parsed.targetMode === 'ideal' ? 'ideal' : 'current',
      idealBudgets: parsed.idealBudgets && typeof parsed.idealBudgets === 'object' ? parsed.idealBudgets : {},
      customBudgets: Array.isArray(parsed.customBudgets) ? parsed.customBudgets : [],
    }
  } catch {
    return defaultSettings
  }
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))

export function FirePlan({ userId, categories, records, loading }: FirePlanProps) {
  const storageKey = `worthdelta:fire-plan:${userId}`
  const [settings, setSettings] = useState<FireSettings>(() => readSettings(storageKey))
  const [showBreakdown, setShowBreakdown] = useState(false)

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(settings))
  }, [settings, storageKey])

  const expenseCategories = useMemo(() => categories
    .filter((category) => category.category_type === 'expense' && !category.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), [categories])

  const activeExpenseIds = useMemo(() => new Set(expenseCategories.map((category) => category.id)), [expenseCategories])
  const activeExpenseNames = useMemo(() => new Set(expenseCategories.map((category) => category.name.toLocaleLowerCase('en'))), [expenseCategories])

  const expenseHistory = useMemo(() => {
    const todayPeriod = currentPeriod()
    const eligible = records.filter((record) => {
      if (record.period > todayPeriod || record.financial_categories?.category_type !== 'expense') return false
      const name = record.financial_categories?.name.toLocaleLowerCase('en') ?? ''
      return activeExpenseIds.has(record.category_id) || activeExpenseNames.has(name)
    })
    const periods = [...new Set(eligible.map((record) => record.period))].sort().slice(-12)
    const periodSet = new Set(periods)
    const selected = eligible.filter((record) => periodSet.has(record.period))
    const monthly = periods.map((period) => ({
      period,
      amount: selected.filter((record) => record.period === period).reduce((sum, record) => sum + Number(record.amount), 0),
    }))
    const total = monthly.reduce((sum, month) => sum + month.amount, 0)
    const monthlyAverage = monthly.length > 0 ? total / monthly.length : 0
    const annual = monthly.length === 12 ? total : monthlyAverage * 12
    const byCategory = expenseCategories.map((category, index) => {
      const categoryName = category.name.toLocaleLowerCase('en')
      const amount = selected
        .filter((record) => record.category_id === category.id || record.financial_categories?.name.toLocaleLowerCase('en') === categoryName)
        .reduce((sum, record) => sum + Number(record.amount), 0)
      return {
        category,
        amount,
        monthlyAverage: monthly.length > 0 ? amount / monthly.length : 0,
        percentage: total > 0 ? (amount / total) * 100 : 0,
        color: chartColors[index % chartColors.length],
      }
    }).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount)
    return { periods, monthly, total, monthlyAverage, annual, byCategory }
  }, [activeExpenseIds, activeExpenseNames, expenseCategories, records])

  const currentWorth = useMemo(() => {
    const todayPeriod = currentPeriod()
    const assetPeriods = records
      .filter((record) => record.period <= todayPeriod && record.financial_categories?.category_type === 'asset')
      .map((record) => record.period)
      .sort()
    const period = assetPeriods.at(-1) ?? ''
    if (!period) return { period: '', value: 0 }
    const assets = records
      .filter((record) => record.period === period && record.financial_categories?.category_type === 'asset')
      .reduce((sum, record) => sum + Number(record.amount), 0)
    const expenses = records
      .filter((record) => record.period === period && record.financial_categories?.category_type === 'expense')
      .reduce((sum, record) => sum + Number(record.amount), 0)
    return { period, value: Math.max(0, assets - expenses) }
  }, [records])

  const realReturn = ((1 + settings.nominalReturn / 100) / (1 + settings.inflation / 100)) - 1
  const validReturn = Number.isFinite(realReturn) && realReturn > 0
  const currentTarget = validReturn ? expenseHistory.annual / realReturn : 0
  const idealMonthly = Object.values(settings.idealBudgets)
    .filter((budget) => budget.enabled)
    .reduce((sum, budget) => sum + Math.max(0, Number(budget.amount) || 0), 0)
    + settings.customBudgets
      .filter((budget) => budget.enabled)
      .reduce((sum, budget) => sum + Math.max(0, Number(budget.amount) || 0), 0)
  const idealAnnual = idealMonthly * 12
  const idealTarget = validReturn ? idealAnnual / realReturn : 0
  const canUseIdeal = idealAnnual > 0
  const targetMode = settings.targetMode === 'ideal' && canUseIdeal ? 'ideal' : 'current'
  const selectedTarget = targetMode === 'ideal' ? idealTarget : currentTarget
  const hasTarget = validReturn && selectedTarget > 0
  const remaining = Math.max(selectedTarget - currentWorth.value, 0)
  const aboveTarget = Math.max(currentWorth.value - selectedTarget, 0)
  const achieved = hasTarget && currentWorth.value >= selectedTarget
  const rawProgress = selectedTarget > 0 ? (currentWorth.value / selectedTarget) * 100 : 0
  const progress = clampPercent(rawProgress)
  const spendingMultiple = realReturn > 0 ? 1 / realReturn : 0
  const maxMonthlySpend = Math.max(...expenseHistory.monthly.map((month) => month.amount), 1)

  const updateBudget = (categoryId: string, patch: Partial<IdealBudget>) => {
    setSettings((current) => {
      const existing = current.idealBudgets[categoryId] ?? { enabled: true, amount: 0 }
      return {
        ...current,
        idealBudgets: {
          ...current.idealBudgets,
          [categoryId]: { ...existing, ...patch },
        },
      }
    })
  }

  const addCustomBudget = () => {
    setSettings((current) => ({
      ...current,
      customBudgets: [...current.customBudgets, {
        id: `custom-${Date.now()}`,
        name: 'New lifestyle item',
        enabled: true,
        amount: 0,
      }],
    }))
  }

  return <section className="fire-plan" aria-label="F.I.R.E plan">
    <article className={`fire-progress-card ${achieved ? 'achieved' : ''}`}>
      <div className="fire-progress-copy">
        <div className="fire-progress-heading">
          <span className="fire-icon"><Campfire weight="duotone" aria-hidden="true" /></span>
          <div><p className="eyebrow">Your path to freedom</p><h2>{achieved ? 'FREEDOM!' : !validReturn ? 'Return must beat inflation' : !hasTarget ? 'Add expenses to reveal your freedom number' : `${formatCurrency(remaining)} more to reach freedom`}</h2></div>
        </div>
        <p className="fire-progress-detail">{achieved
          ? `You are ${formatCurrency(aboveTarget)} above your ${targetMode} lifestyle F.I.R.E target.`
          : hasTarget ? `You have ${formatCurrency(currentWorth.value)} toward a ${formatCurrency(selectedTarget)} ${targetMode} lifestyle target.` : 'Your progress will appear as soon as there is enough data to calculate a target.'}</p>
        {achieved && <div className="freedom-sparkles" aria-hidden="true"><Sparkle weight="fill" /><Sparkle weight="fill" /><Sparkle weight="fill" /></div>}
      </div>

      <div className="fire-target-switch" aria-label="Freedom target">
        <span>Target</span>
        <button className={targetMode === 'current' ? 'active' : ''} type="button" onClick={() => setSettings((current) => ({ ...current, targetMode: 'current' }))}>Current lifestyle</button>
        <button className={targetMode === 'ideal' ? 'active' : ''} type="button" disabled={!canUseIdeal} title={!canUseIdeal ? 'Add an ideal lifestyle budget first' : undefined} onClick={() => setSettings((current) => ({ ...current, targetMode: 'ideal' }))}>Ideal lifestyle</button>
      </div>

      <div className="fire-progress-label"><strong>{hasTarget ? `${Math.round(rawProgress)}% of the way there` : 'Add spending data to begin'}</strong><span title="This is a planning estimate, not a guarantee."><Info aria-hidden="true" />Planning estimate</span></div>
      <div className="fire-progress-track" role="progressbar" aria-label="Progress toward financial freedom" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
        <span className="fire-progress-fill" style={{ width: `${progress}%` }} />
        {progress > 3 && <span className="fire-progress-marker" style={{ left: `${progress}%` }}><Campfire weight="fill" aria-hidden="true" /></span>}
        <FlagCheckered className="fire-finish" weight="duotone" aria-hidden="true" />
      </div>
      <div className="fire-progress-axis"><span>Today: {formatCurrency(currentWorth.value)}</span><span>Freedom: {formatCurrency(selectedTarget)}</span></div>
      <p className="fire-source">Current worth uses your latest asset snapshot{currentWorth.period ? ` (${formatMonth(currentWorth.period)})` : ''}, after that month’s expenses.</p>
    </article>

    <div className="fire-planning-grid">
      <article className="fire-card fire-current-card">
        <header className="fire-card-heading">
          <span className="fire-card-icon"><Receipt weight="duotone" aria-hidden="true" /></span>
          <div><p className="eyebrow">Current lifestyle baseline</p><h2>Your life today</h2><p>{expenseHistory.periods.length > 0 ? `${formatMonth(expenseHistory.periods[0])} – ${formatMonth(expenseHistory.periods.at(-1) ?? '')}` : 'Waiting for expense records'}</p></div>
        </header>

        {loading ? <p className="fire-empty">Loading your spending history…</p> : expenseHistory.periods.length === 0 ? <p className="fire-empty">Add expense records to calculate your current lifestyle target.</p> : <>
          <div className="fire-number-pair"><div><span>Annual spending</span><strong>{formatCurrency(expenseHistory.annual)}</strong></div><div><span>Monthly average</span><strong>{formatCurrency(expenseHistory.monthlyAverage)}</strong></div></div>
          {expenseHistory.periods.length < 12 && <p className="fire-data-note"><Info aria-hidden="true" />Annualised from {expenseHistory.periods.length} {expenseHistory.periods.length === 1 ? 'month' : 'months'} of available data.</p>}

          <div className="fire-mini-chart" aria-label="Monthly expense history">
            {expenseHistory.monthly.map((month) => <div className="fire-mini-column" key={month.period} title={`${formatMonth(month.period)}: ${formatCurrency(month.amount)}`}><span style={{ height: `${Math.max(7, (month.amount / maxMonthlySpend) * 100)}%` }} /><small>{formatMonth(month.period).slice(0, 3)}</small></div>)}
          </div>

          <button className="fire-breakdown-toggle" type="button" aria-expanded={showBreakdown} onClick={() => setShowBreakdown((current) => !current)}>What’s included?<span>{showBreakdown ? 'Hide' : 'View categories'}</span></button>
          {showBreakdown && <div className="fire-breakdown-list">{expenseHistory.byCategory.map((item) => <div key={item.category.id}><span className="fire-category-dot" style={{ background: item.color }} />{item.category.icon && <span aria-hidden="true">{item.category.icon}</span>}<strong>{item.category.name}</strong><span>{item.percentage.toFixed(0)}%</span><b>{formatCurrency(item.amount)}</b></div>)}</div>}
        </>}

        <section className="fire-assumptions" aria-labelledby="fire-assumptions-title">
          <div><p className="eyebrow">Assumptions</p><h3 id="fire-assumptions-title">Your sustainable return</h3></div>
          <div className="fire-assumption-fields">
            <label><span>Passive annual return</span><span className="fire-percent-input"><input type="number" min="0" max="100" step="0.1" value={settings.nominalReturn} onChange={(event) => setSettings((current) => ({ ...current, nominalReturn: Number(event.target.value) }))} /><b>%</b></span></label>
            <label><span>Inflation</span><span className="fire-percent-input"><input type="number" min="0" max="100" step="0.1" value={settings.inflation} onChange={(event) => setSettings((current) => ({ ...current, inflation: Number(event.target.value) }))} /><b>%</b></span></label>
            <div className="fire-real-return"><span>Real return for spending</span><strong>{(realReturn * 100).toFixed(1)}%</strong></div>
          </div>
          <p className="fire-saved-note">Your latest edits save automatically on this device.</p>
          <p className="fire-helper">Return remaining after inflation, before taxes and investment fees.</p>
          {!validReturn && <p className="fire-return-warning">Your return must be higher than inflation to calculate a sustainable target.</p>}
        </section>

        <section className="fire-target-result"><span>Forever-fund target</span><strong>{validReturn ? formatCurrency(currentTarget) : '—'}</strong><small>{validReturn ? `About ${spendingMultiple.toFixed(1)}× your annual spending.` : 'Adjust your assumptions to continue.'}</small></section>
      </article>

      <article className="fire-card fire-ideal-card">
        <header className="fire-card-heading">
          <span className="fire-card-icon"><MagicWand weight="duotone" aria-hidden="true" /></span>
          <div><p className="eyebrow">My ideal lifestyle</p><h2>Design your freedom</h2><p>Choose what you want your future years to include.</p></div>
        </header>

        <div className="fire-budget-list">
          {expenseCategories.map((category) => {
            const budget = settings.idealBudgets[category.id] ?? { enabled: false, amount: 0 }
            return <div className={`fire-budget-row ${budget.enabled ? 'enabled' : ''}`} key={category.id}>
              <label className="fire-budget-toggle"><input type="checkbox" checked={budget.enabled} onChange={(event) => updateBudget(category.id, { enabled: event.target.checked })} /><span aria-hidden="true" /> <b>{category.icon || '•'}</b><strong>{category.name}</strong></label>
              <label className="fire-budget-amount"><span className="sr-only">Monthly amount for {category.name}</span><b>RM</b><input type="number" min="0" step="1" value={budget.amount || ''} placeholder="0" disabled={!budget.enabled} onChange={(event) => updateBudget(category.id, { amount: Number(event.target.value) })} /></label>
            </div>
          })}

          {settings.customBudgets.map((budget) => <div className={`fire-budget-row custom ${budget.enabled ? 'enabled' : ''}`} key={budget.id}>
            <div className="fire-budget-custom-info"><label className="fire-budget-toggle"><input type="checkbox" checked={budget.enabled} aria-label={`Include ${budget.name}`} onChange={(event) => setSettings((current) => ({ ...current, customBudgets: current.customBudgets.map((item) => item.id === budget.id ? { ...item, enabled: event.target.checked } : item) }))} /><span aria-hidden="true" /></label><input className="fire-custom-name" value={budget.name} maxLength={60} aria-label="Custom lifestyle category name" onChange={(event) => setSettings((current) => ({ ...current, customBudgets: current.customBudgets.map((item) => item.id === budget.id ? { ...item, name: event.target.value } : item) }))} /></div>
            <label className="fire-budget-amount"><span className="sr-only">Monthly amount for {budget.name}</span><b>RM</b><input type="number" min="0" step="1" value={budget.amount || ''} placeholder="0" disabled={!budget.enabled} onChange={(event) => setSettings((current) => ({ ...current, customBudgets: current.customBudgets.map((item) => item.id === budget.id ? { ...item, amount: Number(event.target.value) } : item) }))} /></label>
            <button className="fire-remove-custom" type="button" aria-label={`Remove ${budget.name}`} onClick={() => setSettings((current) => ({ ...current, customBudgets: current.customBudgets.filter((item) => item.id !== budget.id) }))}><Trash aria-hidden="true" /></button>
          </div>)}
        </div>

        <button className="fire-add-custom" type="button" onClick={addCustomBudget}><Plus aria-hidden="true" />Add custom category</button>

        <section className="fire-ideal-summary">
          <div className="fire-summary-art" aria-hidden="true"><Sparkle weight="duotone" /><Campfire weight="duotone" /></div>
          <p className="eyebrow">Your ideal life</p>
          <div className="fire-number-pair"><div><span>Monthly lifestyle</span><strong>{formatCurrency(idealMonthly)}</strong></div><div><span>Annual lifestyle</span><strong>{formatCurrency(idealAnnual)}</strong></div></div>
          <div className="fire-ideal-target"><span>Ideal forever-fund</span><strong>{validReturn && idealAnnual > 0 ? formatCurrency(idealTarget) : '—'}</strong></div>
          <div className="fire-comparisons"><span>{formatCurrency(Math.abs(idealMonthly - expenseHistory.monthlyAverage))} {idealMonthly >= expenseHistory.monthlyAverage ? 'more' : 'less'} per month than today</span><span>{formatCurrency(Math.abs(idealTarget - currentTarget))} {idealTarget >= currentTarget ? 'more' : 'less'} than your current target</span></div>
        </section>
      </article>
    </div>
  </section>
}
