import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  ChartLineUp,
  Database,
  FileArrowUp,
  Money,
  Plus,
  SignOut,
  SpinnerGap,
  TrendDown,
  TrendUp,
  Wallet,
} from '@phosphor-icons/react'
import { importHistory } from './lib/historyImport'
import { supabase } from './lib/supabase'
import type { CategoryType, FinancialCategory, MonthlyRecord } from './types'
import './App.css'

const categoryMeta: Record<CategoryType, { label: string; icon: typeof Wallet }> = {
  asset: { label: 'Assets', icon: Wallet },
  income: { label: 'Income', icon: TrendUp },
  expense: { label: 'Expenses', icon: TrendDown },
  investment: { label: 'Investments', icon: ChartLineUp },
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-MY', {
    style: 'currency',
    currency: 'MYR',
    maximumFractionDigits: 0,
  }).format(value)

const formatMonth = (period: string) =>
  new Intl.DateTimeFormat('en-MY', { month: 'short', year: 'numeric' }).format(
    new Date(`${period.slice(0, 7)}-02T00:00:00`),
  )

const HUB_URL = 'https://kencode404.github.io/K-Super-Hub/'

function HubRedirect() {
  useEffect(() => {
    const destination = new URL(HUB_URL)
    destination.searchParams.set(
      'next',
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    )
    window.location.replace(destination.href)
  }, [])

  return (
    <main className="boot-screen">
      <span className="brand-mark" aria-hidden="true">Δ</span>
      <SpinnerGap className="spin" aria-label="Opening K-Super Hub" />
    </main>
  )
}

function TrendChart({ points }: { points: Array<{ period: string; value: number }> }) {
  if (points.length < 2) return <div className="chart-empty">Add asset records to reveal your trend.</div>
  const width = 760
  const height = 230
  const padding = 18
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = max - min || 1
  const coordinates = points.map((point, index) => ({
    ...point,
    x: padding + (index / (points.length - 1)) * (width - padding * 2),
    y: height - padding - ((point.value - min) / spread) * (height - padding * 2),
  }))
  const path = coordinates.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Asset value trend from ${formatMonth(points[0].period)} to ${formatMonth(points.at(-1)!.period)}`}>
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${path} L ${coordinates.at(-1)!.x} ${height} L ${coordinates[0].x} ${height} Z`} fill="url(#chartFill)" />
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {coordinates.map((point) => <circle key={point.period} cx={point.x} cy={point.y} r="5" fill="var(--surface)" stroke="var(--brand)" strokeWidth="3"><title>{formatMonth(point.period)}: {formatCurrency(point.value)}</title></circle>)}
      </svg>
      <div className="chart-labels"><span>{formatMonth(points[0].period)}</span><span>{formatMonth(points.at(-1)!.period)}</span></div>
    </div>
  )
}

function Dashboard({ session }: { session: Session }) {
  const [categories, setCategories] = useState<FinancialCategory[]>([])
  const [records, setRecords] = useState<MonthlyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [type, setType] = useState<CategoryType>('asset')
  const [categoryName, setCategoryName] = useState('')
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [amount, setAmount] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  async function loadData() {
    setLoading(true)
    const [categoryResult, recordResult] = await Promise.all([
      supabase.from('worthdelta_financial_categories').select('*').order('sort_order'),
      supabase.from('worthdelta_monthly_records').select('*, financial_categories:worthdelta_financial_categories(name, category_type)').order('period', { ascending: false }),
    ])
    setLoading(false)
    const error = categoryResult.error ?? recordResult.error
    if (error) {
      setLoadError(error.message)
      return
    }
    setLoadError('')
    setCategories(categoryResult.data as FinancialCategory[])
    setRecords(recordResult.data as unknown as MonthlyRecord[])
  }

  useEffect(() => { void loadData() }, [])

  const assetTrend = useMemo(() => {
    const totals = new Map<string, number>()
    records.filter((record) => record.financial_categories?.category_type === 'asset').forEach((record) => {
      totals.set(record.period, (totals.get(record.period) ?? 0) + Number(record.amount))
    })
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([pointPeriod, value]) => ({ period: pointPeriod, value }))
  }, [records])

  const activePeriod = assetTrend.at(-1)?.period ?? records[0]?.period ?? `${period}-01`
  const monthRecords = records.filter((record) => record.period === activePeriod)
  const totalFor = (recordType: CategoryType) => monthRecords
    .filter((record) => record.financial_categories?.category_type === recordType)
    .reduce((total, record) => total + Number(record.amount), 0)
  const assets = totalFor('asset')
  const income = totalFor('income')
  const expenses = totalFor('expense')
  const investments = totalFor('investment')

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!categoryName.trim() || !amount) return
    setSaving(true)
    setNotice('')

    let category = categories.find((item) => item.category_type === type && item.name.toLocaleLowerCase() === categoryName.trim().toLocaleLowerCase())
    if (!category) {
      const { data, error } = await supabase.from('worthdelta_financial_categories').insert({ user_id: session.user.id, category_type: type, name: categoryName.trim(), sort_order: categories.length + 1 }).select().single()
      if (error) { setNotice(error.message); setSaving(false); return }
      category = data as FinancialCategory
    }

    const { error } = await supabase.from('worthdelta_monthly_records').upsert({
      user_id: session.user.id,
      category_id: category.id,
      period: `${period}-01`,
      amount: Number(amount),
      source: 'manual',
    }, { onConflict: 'user_id,category_id,period' })

    setSaving(false)
    if (error) { setNotice(error.message); return }
    setAmount('')
    setCategoryName('')
    setNotice('Record saved.')
    await loadData()
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setSaving(true)
    setNotice('Importing your history…')
    try {
      const result = await importHistory(file, session.user)
      setNotice(`Imported ${result.records.toLocaleString()} records across ${result.categories} categories.`)
      await loadData()
    } catch (importError) {
      setNotice(importError instanceof Error ? importError.message : 'Import failed.')
    } finally {
      setSaving(false)
      event.target.value = ''
    }
  }

  const filteredCategories = categories.filter((category) => category.category_type === type)

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand brand-light" href={import.meta.env.BASE_URL} aria-label="WorthDelta home"><span className="brand-mark" aria-hidden="true">Δ</span><span>WorthDelta</span></a>
        <nav aria-label="Dashboard"><a className="nav-item active" href="#overview"><ChartLineUp aria-hidden="true" />Overview</a><a className="nav-item" href="#records"><Money aria-hidden="true" />Records</a></nav>
        <div className="sidebar-user"><span className="avatar">{(session.user.email?.[0] ?? 'W').toUpperCase()}</span><span><strong>{session.user.user_metadata.full_name ?? 'WorthDelta user'}</strong><small>{session.user.email}</small></span><button type="button" onClick={() => void supabase.auth.signOut()} aria-label="Sign out"><SignOut aria-hidden="true" /></button></div>
      </aside>

      <main className="dashboard-main" id="overview">
        <header className="dashboard-header"><div><p className="eyebrow">Personal finance dashboard</p><h1>Your worth, in motion.</h1><p>Latest asset snapshot: {formatMonth(activePeriod)}</p></div><button className="outline-button" type="button" onClick={() => fileInput.current?.click()} disabled={saving}><FileArrowUp aria-hidden="true" />Import history</button><input ref={fileInput} className="sr-only" type="file" accept="application/json,.json" onChange={handleImport} /></header>

        {loadError && <section className="setup-banner" role="alert"><Database aria-hidden="true" /><div><strong>Database setup required</strong><p>{loadError.includes('schema cache') ? 'Run the included Supabase migration before adding or importing records.' : loadError}</p><code>supabase/migrations/20260816000000_initial_worthdelta.sql</code></div></section>}
        {notice && <p className="notice" role="status">{notice}</p>}

        <section className="metric-grid" aria-label="Monthly summary">
          <article><span>Asset value</span><strong>{formatCurrency(assets)}</strong><small>Current snapshot</small></article>
          <article><span>Monthly income</span><strong>{formatCurrency(income)}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly expenses</span><strong>{formatCurrency(expenses)}</strong><small>{income ? `${Math.round((expenses / income) * 100)}% of income` : 'No income recorded'}</small></article>
          <article><span>Invested</span><strong>{formatCurrency(investments)}</strong><small>{formatMonth(activePeriod)}</small></article>
        </section>

        <section className="dashboard-grid">
          <article className="panel trend-panel"><div className="panel-heading"><div><p className="eyebrow">Asset trajectory</p><h2>12-month trend</h2></div>{assetTrend.length > 1 && <span className="trend-badge"><TrendUp aria-hidden="true" />{formatCurrency(assetTrend.at(-1)!.value - assetTrend[0].value)}</span>}</div>{loading ? <div className="loading-state"><SpinnerGap className="spin" aria-hidden="true" />Loading records…</div> : <TrendChart points={assetTrend} />}</article>

          <article className="panel add-panel" id="records"><div className="panel-heading"><div><p className="eyebrow">Future records</p><h2>Add or update a month</h2></div><Plus aria-hidden="true" /></div><form onSubmit={handleSave}>
            <label><span>Record type</span><select value={type} onChange={(event) => { setType(event.target.value as CategoryType); setCategoryName('') }}>{(Object.keys(categoryMeta) as CategoryType[]).map((key) => <option key={key} value={key}>{categoryMeta[key].label}</option>)}</select></label>
            <label><span>Category</span><input list="category-list" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Choose or create a category" required /><datalist id="category-list">{filteredCategories.map((category) => <option key={category.id} value={category.name} />)}</datalist></label>
            <div className="form-row"><label><span>Month</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} required /></label><label><span>Amount (MYR)</span><input type="number" inputMode="decimal" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></label></div>
            <button className="primary-button" type="submit" disabled={saving || !!loadError}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Save record</button>
          </form></article>
        </section>

        <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">Recent activity</p><h2>Latest records</h2></div></div>{records.length === 0 ? <div className="empty-state"><Database aria-hidden="true" /><h3>No records yet</h3><p>Import the prepared history file or add your first monthly record.</p></div> : <div className="record-list">{records.slice(0, 8).map((record) => { const meta = categoryMeta[record.financial_categories?.category_type ?? 'expense']; const Icon = meta.icon; return <div className="record-row" key={record.id}><span className={`record-icon ${record.financial_categories?.category_type}`}><Icon aria-hidden="true" /></span><span className="record-name"><strong>{record.financial_categories?.name}</strong><small>{meta.label} · {formatMonth(record.period)}</small></span><strong className="record-amount">{formatCurrency(Number(record.amount))}</strong></div>})}</div>}</section>
      </main>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false) })
    return () => data.subscription.unsubscribe()
  }, [])

  if (loading) return <main className="boot-screen"><span className="brand-mark" aria-hidden="true">Δ</span><SpinnerGap className="spin" aria-label="Loading WorthDelta" /></main>
  return session ? <Dashboard session={session} /> : <HubRedirect />
}

export default App
