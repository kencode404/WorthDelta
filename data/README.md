# Private import data

`worthdelta-history.json` contains normalized personal finance data exported from
the source Google Sheet. The detailed version preserves exact cells, formulas,
and each additive formula component. These files are intentionally ignored by Git and must never be
placed in `src/` or `public/` because those folders are included in browser builds.
