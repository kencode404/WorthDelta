# WorthDelta

WorthDelta is a private personal-finance dashboard built with React, TypeScript,
Vite, and Supabase.

## Included

- Shared email and Google authentication through K-Super Hub
- Private per-user categories and monthly records with row-level security
- Asset, income, expense, and investment summaries
- Responsive 12-month asset trend
- Add/update workflow for future monthly records
- One-time import of the normalized 2022–2026 Google Sheets history

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
3. Choose `data/worthdelta-history.json`.

The import is idempotent: importing the file again updates the same monthly
category records instead of duplicating them. The JSON is ignored by Git and is
never bundled into the frontend.

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
