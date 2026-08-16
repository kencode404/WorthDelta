# Private import data

`worthdelta-history.json` contains normalized personal finance data exported from
the source Google Sheet. It is intentionally ignored by Git and must never be
placed in `src/` or `public/` because those folders are included in browser builds.
