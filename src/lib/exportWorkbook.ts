import type { CategoryType, ExpenseGroup, FinancialCategory, LedgerEntry, MonthlyRecord } from '../types'

interface ExportInput {
  categories: FinancialCategory[]
  groups: ExpenseGroup[]
  records: MonthlyRecord[]
  entries: LedgerEntry[]
  chartImage?: string | null
}

const SECTIONS: Array<{ type: CategoryType; label: string; tint: string; accent: string }> = [
  { type: 'asset', label: 'Assets', tint: 'FFDDF3E4', accent: 'FF2F7D51' },
  { type: 'income', label: 'Income', tint: 'FFDFF2ED', accent: 'FF1F7A66' },
  { type: 'expense', label: 'Expenses', tint: 'FFFBE6DA', accent: 'FFB4531B' },
  { type: 'investment', label: 'Investments', tint: 'FFE4ECFA', accent: 'FF3B6FB5' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FIRST_MONTH_COL = 5 // column E
const TOTAL_COL = FIRST_MONTH_COL + 12 // column Q
const MONEY_FORMAT = '#,##0.00'

const columnLetter = (index: number) => {
  let column = ''
  let value = index
  while (value > 0) {
    const remainder = (value - 1) % 26
    column = String.fromCharCode(65 + remainder) + column
    value = Math.floor((value - 1) / 26)
  }
  return column
}

const periodFor = (year: number, monthIndex: number) => `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`

const sameName = (a?: string | null, b?: string | null) =>
  (a ?? '').toLocaleLowerCase('en') === (b ?? '').toLocaleLowerCase('en')

/**
 * One cell holds the whole month for a category, as the source sheet does:
 * several amounts stay visible as `=12.5+30+8`, a single amount stays a number.
 */
function cellValue(
  category: FinancialCategory,
  period: string,
  records: MonthlyRecord[],
  entries: LedgerEntry[],
) {
  const own = entries.filter((entry) =>
    entry.period === period &&
    (entry.category_id === category.id || (
      entry.financial_categories?.category_type === category.category_type &&
      sameName(entry.financial_categories?.name, category.name)
    )),
  )
  if (own.length > 1) {
    const parts = own
      .map((entry) => Number(entry.amount))
      .filter((amount) => amount !== 0)
      .map((amount) => String(Number(amount.toFixed(2))))
    if (parts.length > 1) return { formula: parts.join('+') }
    if (parts.length === 1) return Number(parts[0])
  }
  if (own.length === 1) return Number(Number(own[0].amount).toFixed(2))

  const record = records.find((item) =>
    item.period === period &&
    (item.category_id === category.id || (
      item.financial_categories?.category_type === category.category_type &&
      sameName(item.financial_categories?.name, category.name)
    )),
  )
  if (!record) return null
  const amount = Number(record.amount)
  return amount === 0 ? null : Number(amount.toFixed(2))
}

export async function downloadWorkbook(input: ExportInput) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'WorthDelta'
  workbook.created = new Date()

  const years = [...new Set(input.records.map((record) => Number(record.period.slice(0, 4))))]
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a)

  const thin = { style: 'thin' as const, color: { argb: 'FFD3DBE6' } }
  const allBorders = { top: thin, left: thin, bottom: thin, right: thin }

  for (const year of years) {
    const sheet = workbook.addWorksheet(String(year), {
      views: [{ state: 'frozen', xSplit: 4, ySplit: 3 }],
    })
    sheet.getColumn(1).width = 3
    sheet.getColumn(2).width = 14
    sheet.getColumn(3).width = 14
    sheet.getColumn(4).width = 30
    for (let column = FIRST_MONTH_COL; column <= TOTAL_COL; column += 1) sheet.getColumn(column).width = 13

    const title = sheet.getCell(1, 2)
    title.value = `WorthDelta — ${year}`
    title.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF172E57' } }

    const header = sheet.getRow(3)
    header.getCell(2).value = 'Section'
    header.getCell(3).value = 'Group'
    header.getCell(4).value = 'Category'
    MONTHS.forEach((month, index) => { header.getCell(FIRST_MONTH_COL + index).value = month })
    header.getCell(TOTAL_COL).value = 'Total'
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172E57' } }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border = allBorders
    })
    header.height = 22

    let rowIndex = 4
    const totalRows: Partial<Record<CategoryType, number>> = {}

    for (const section of SECTIONS) {
      const sectionGroups = input.groups.filter((group) => group.category_type === section.type)
      const sectionCategories = input.categories
        .filter((category) => category.category_type === section.type)
        .sort((a, b) => {
          const groupA = sectionGroups.findIndex((group) => group.id === a.expense_group_id)
          const groupB = sectionGroups.findIndex((group) => group.id === b.expense_group_id)
          return (groupA < 0 ? sectionGroups.length : groupA) - (groupB < 0 ? sectionGroups.length : groupB)
            || a.sort_order - b.sort_order
            || a.name.localeCompare(b.name)
        })
      if (sectionCategories.length === 0) continue

      const firstRow = rowIndex
      sectionCategories.forEach((category) => {
        const row = sheet.getRow(rowIndex)
        row.getCell(2).value = section.label
        row.getCell(3).value = sectionGroups.find((group) => group.id === category.expense_group_id)?.name ?? ''
        row.getCell(4).value = category.name

        MONTHS.forEach((_, monthIndex) => {
          const cell = row.getCell(FIRST_MONTH_COL + monthIndex)
          const value = cellValue(category, periodFor(year, monthIndex), input.records, input.entries)
          if (value !== null) cell.value = value as never
          cell.numFmt = MONEY_FORMAT
        })

        const totalCell = row.getCell(TOTAL_COL)
        if (section.type !== 'asset') {
          totalCell.value = { formula: `SUM(${columnLetter(FIRST_MONTH_COL)}${rowIndex}:${columnLetter(TOTAL_COL - 1)}${rowIndex})` }
          totalCell.font = { bold: true }
        }
        totalCell.numFmt = MONEY_FORMAT

        row.eachCell({ includeEmpty: true }, (cell, column) => {
          if (column < 2 || column > TOTAL_COL) return
          cell.border = allBorders
          if (column <= 4) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: section.tint } }
        })
        rowIndex += 1
      })

      const totalRow = sheet.getRow(rowIndex)
      totalRow.getCell(2).value = `${section.label} total`
      for (let column = FIRST_MONTH_COL; column <= TOTAL_COL; column += 1) {
        const letter = columnLetter(column)
        const cell = totalRow.getCell(column)
        // the month columns add up the categories; the Total column would add up
        // twelve balances, so assets leave it empty
        if (column < TOTAL_COL || section.type !== 'asset') {
          cell.value = { formula: `SUM(${letter}${firstRow}:${letter}${rowIndex - 1})` }
        }
        cell.numFmt = MONEY_FORMAT
      }
      totalRow.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column < 2 || column > TOTAL_COL) return
        cell.border = allBorders
        cell.font = { bold: true, color: { argb: section.accent } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: section.tint } }
      })
      totalRows[section.type] = rowIndex
      rowIndex += 2
    }

    // closing worth = assets less that month's spending, the same arithmetic the app shows
    if (totalRows.asset && totalRows.expense) {
      const worthRow = sheet.getRow(rowIndex)
      worthRow.getCell(2).value = 'Closing worth'
      for (let column = FIRST_MONTH_COL; column <= TOTAL_COL - 1; column += 1) {
        const letter = columnLetter(column)
        const cell = worthRow.getCell(column)
        cell.value = { formula: `IF(${letter}${totalRows.asset}=0,"",${letter}${totalRows.asset}-${letter}${totalRows.expense})` }
        cell.numFmt = MONEY_FORMAT
      }
      worthRow.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column < 2 || column > TOTAL_COL) return
        cell.border = allBorders
        cell.font = { bold: true, color: { argb: 'FF172E57' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7ECF5' } }
      })

      // every derived row stays a live formula, so editing a month recalculates the lot
      const derived: Array<{ label: string; format: string; formula: (letter: string, previous: string | null) => string | null }> = [
        {
          label: 'Worth change',
          format: MONEY_FORMAT,
          formula: (letter, previous) => previous === null
            ? null
            : `IF(OR(${letter}${rowIndex}="",${previous}${rowIndex}=""),"",${letter}${rowIndex}-${previous}${rowIndex})`,
        },
        {
          label: 'Worth change %',
          format: '0.0%',
          formula: (letter, previous) => previous === null
            ? null
            : `IF(OR(${letter}${rowIndex}="",${previous}${rowIndex}="",${previous}${rowIndex}=0),"",(${letter}${rowIndex}-${previous}${rowIndex})/${previous}${rowIndex})`,
        },
        {
          label: 'Savings rate',
          format: '0.0%',
          formula: (letter) => totalRows.income
            ? `IF(${letter}${totalRows.income}=0,"",(${letter}${totalRows.income}-${letter}${totalRows.expense})/${letter}${totalRows.income})`
            : null,
        },
        {
          label: 'Invested % of income',
          format: '0.0%',
          formula: (letter) => totalRows.income && totalRows.investment
            ? `IF(${letter}${totalRows.income}=0,"",${letter}${totalRows.investment}/${letter}${totalRows.income})`
            : null,
        },
      ]

      const worthRowIndex = rowIndex
      derived.forEach((definition, definitionIndex) => {
        const row = sheet.getRow(worthRowIndex + definitionIndex + 1)
        row.getCell(2).value = definition.label
        for (let column = FIRST_MONTH_COL; column <= TOTAL_COL - 1; column += 1) {
          const letter = columnLetter(column)
          const previous = column > FIRST_MONTH_COL ? columnLetter(column - 1) : null
          const formula = definition.formula(letter, previous)
          const cell = row.getCell(column)
          if (formula) cell.value = { formula }
          cell.numFmt = definition.format
        }
        row.eachCell({ includeEmpty: true }, (cell, column) => {
          if (column < 2 || column > TOTAL_COL) return
          cell.border = allBorders
          cell.font = { color: { argb: 'FF3D4C63' } }
        })
      })
    }
  }

  if (input.chartImage) {
    const dashboard = workbook.addWorksheet('Dashboard', { views: [{ showGridLines: false }] })
    dashboard.getCell(2, 2).value = 'Annual overview'
    dashboard.getCell(2, 2).font = { size: 15, bold: true, color: { argb: 'FF172E57' } }
    dashboard.getCell(3, 2).value = 'Snapshot of the WorthDelta chart at the time of export.'
    dashboard.getCell(3, 2).font = { size: 10, color: { argb: 'FF5F6E82' } }
    const imageId = workbook.addImage({ base64: input.chartImage.split(',')[1], extension: 'png' })
    dashboard.addImage(imageId, { tl: { col: 1, row: 4 }, ext: { width: 1000, height: 380 } })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `WorthDelta-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Rasterises the on-screen chart; the SVG's styles live in a stylesheet, so they are inlined first. */
export async function captureChartImage(): Promise<string | null> {
  const source = document.querySelector('.annual-chart') as SVGSVGElement | null
  if (!source) return null
  const clone = source.cloneNode(true) as SVGSVGElement
  const viewBox = (source.getAttribute('viewBox') ?? '0 0 1080 380').split(' ').map(Number)
  const width = viewBox[2] || 1080
  const height = viewBox[3] || 380
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = `
    text { fill: #68778b; font: 11px 'Nunito', sans-serif; }
    .axis-caption { fill: #5f6e82; font-size: 10px; font-weight: 800; letter-spacing: .08em; }
    .axis-caption-worth, .axis-worth-tick { fill: #172e57; }
    .annual-year-label { fill: #14233f; font-weight: 800; }
    .income-area { fill: rgba(33, 138, 112, .15); }
    .flow-path { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
    .worth-path { fill: none; stroke: #172e57; stroke-width: 3.5; stroke-dasharray: 9 7; stroke-linecap: round; }
    .worth-dot { fill: #172e57; stroke: #fffefa; stroke-width: 2.5; }
  `
  clone.insertBefore(style, clone.firstChild)

  const serialized = new XMLSerializer().serializeToString(clone)
  const svgUrl = `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(serialized)))}`

  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width * 2
      canvas.height = height * 2
      const context = canvas.getContext('2d')
      if (!context) return resolve(null)
      context.fillStyle = '#fffefa'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => resolve(null)
    image.src = svgUrl
  })
}
