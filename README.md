# sbi-ttb-json

Builds machine-readable JSON from SBI TT historical PDFs published in:
`skbly7/sbi-tt-rates-historical`.

## Output

- `data/by-date/YYYY-MM-DD.json`: per-date TT buying rates by currency
- `data/currency/<CUR>.json`: per-currency time series used by `fx-worker`
- `data/latest.json`: latest known rate per currency

## Local run

1. Install `pdftotext` (Poppler).
   - macOS: `brew install poppler`
2. Build incrementally:
   - `MODE=incremental node scripts/build-dataset.mjs`
3. Full rebuild:
   - `MODE=full node scripts/build-dataset.mjs`

Optional env vars:

- `MODE=incremental|full` (default `incremental`)
- `MAX_FILES=100` to cap processed files (useful for manual backfill)
- `UPSTREAM_REPO=owner/repo` (default `skbly7/sbi-tt-rates-historical`)
- `UPSTREAM_REF=branch-or-sha` (default `master`)

## GitHub Actions

- `daily.yml`: scheduled incremental refresh at 20:30 IST (`15:00 UTC`)
- `backfill.yml`: manual full backfill
