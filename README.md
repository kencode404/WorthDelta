# WorthDelta

WorthDelta is a private personal-finance dashboard built with React, TypeScript,
Vite, and Supabase.

## Included

- Email registration and sign-in
- Google OAuth client flow
- Private per-user categories and monthly records with row-level security
- Asset, income, expense, and investment summaries
- Responsive 12-month asset trend
- Add/update workflow for future monthly records
- One-time import of the normalized 2022–2026 Google Sheets history

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

## Google sign-in setup

The client flow is implemented. To activate it, enable the Google provider in
Supabase Authentication and provide a Google OAuth client ID and secret. Add the
deployed app URL and the local development URL to the allowed redirect URLs.

## Checks

```bash
npm run lint
npm run build
```
