# WorthDelta

WorthDelta is a private personal-finance dashboard built with React, TypeScript,
Vite, and Supabase.

## Included

- Shared email and Google authentication through K-Super Hub
- Private per-user categories, monthly summaries, and detailed ledger entries with row-level security
- Asset, income, expense, and investment summaries
- Spreadsheet-inspired annual overview with a combined comparison chart, yearly totals, and progress cards
- Separate Records view for category analysis, future entries, and the full audit trail
- Selectable full-history chart for every asset, income, expense, and investment category
- Add-entry workflow for future traceable records
- Idempotent import of the normalized 2022–2026 Google Sheets history, including exact source cells and formulas
- Installable phone PWA with WorthDelta home-screen icons
- Offline-first IndexedDB cache with automatic Supabase synchronization

All app-owned database objects use the `worthdelta_` prefix so this Supabase
schema can safely host additional applications.

## Run locally

```bash
npm install
npm run dev
```

The app reads its Supabase connection from `.env.local`.

## Import the prepared history

1. Register and sign in to WorthDelta.
2. Select **Import history** in the dashboard.
3. Choose `data/worthdelta-history-detailed.json`.

The import is idempotent: importing the file again updates the same monthly
summaries and source-linked ledger entries instead of duplicating them. Each
imported entry retains the Google Sheet tab, exact cell, original formula, and
formula-component index. The JSON is ignored by Git and is never bundled into
the frontend.

## Offline use

After the first signed-in visit, WorthDelta can open without a network
connection. Dashboard data is cached per user in IndexedDB. Manual entries and
history imports made offline are stored in a durable queue and synchronized with
Supabase when the browser reconnects. Monthly summaries are updated alongside
their detailed entries.

## Shared authentication

Signed-out visitors are redirected to
[`K-Super-Hub`](https://github.com/kencode404/K-Super-Hub) with a validated
return path. Both apps use the same Supabase project and GitHub Pages origin, so
the authenticated browser session is available when the user returns.

## Checks

```bash
npm run lint
npm run build
```
