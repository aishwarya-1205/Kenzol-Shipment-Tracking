# Kenzol - Shipping Tracking

Shipment register and Bill of Lading tracking, hosted on Cloudflare.

- `worker/index.ts`: Cloudflare Worker serving the `/api/*` endpoints and the built frontend.
- `frontend/`: React/Vite app (built into `frontend/dist`, served by the Worker).
- D1 database `kenzol`: the shipment register (`schema.sql`). Each workbook row is stored as JSON keyed by its Excel header.
- `shared/dates.mjs`: date parsing used by the Worker and the scripts. Register dates are stored as `YYYY-MM-DD`.
- Tracking data comes from the SafeCube/Sinay Container Tracking API.

## Secrets

The API key lives in Cloudflare, never in the frontend:

```powershell
npx wrangler secret put SAFECUBE_API
npx wrangler secret put MCL_SCAC   # optional, only with a verified MCL sealine code
```

For local development, put the same values in a root `.env` (not committed):

```env
SAFECUBE_API=your_real_api_key_here
```

## Local development

```powershell
npm install
npm run dev                 # Worker + local D1 on http://127.0.0.1:8787
cd frontend; npm run dev    # optional: Vite with hot reload, proxies /api to 8787
```

`wrangler dev` uses a local copy of D1, which starts empty. Load data with
`npx wrangler d1 execute kenzol --local --file=schema.sql` and then a seed file.

If wrangler says the compatibility date is newer than its runtime, add `--compatibility-date=2026-05-01` for local runs.

## Deploy

```powershell
npm run build    # builds frontend/dist
npm run deploy   # wrangler deploy
```

## Register data

- `node scripts/import-xlsx.mjs backend/data/customs_exit_with_est.xlsx seed.sql` builds a fresh seed from the workbook.
  **The seed wipes the tables**, including edits made in the app (cheque amounts, refund dates, telex and payment status).
- `scripts/fix-dates.mjs` repairs date cells in the live database in place, without losing app edits (usage at the top of the file).
- Keep `backend/data/` out of git (it holds the workbook and database backups).

## API

```http
GET  /api/health
GET  /api/carriers
GET  /api/track?bl_number=...&carrier=...    # carrier optional: MSC, Hapag-Lloyd, CMA CGM, Maersk, MCL
GET  /api/sealines                           # provider's official sealine codes
GET  /api/shipments                          # dashboard rows
POST /api/shipments/update                   # {"row": 457, "fields": {"telexStatus": "Released"}}
GET  /api/notifications                      # arrivals and cheque refunds due within 15 days
GET  /api/excel[?view=all]                   # raw register
GET  /api/excel/download[?format=csv]        # .xlsx (dates as real dd/mm/yyyy cells) or CSV
POST /api/update-excel?bl_number=...         # sync carrier data into the register
POST /api/register/delete                    # {"rows": [12]} or {"bl": "..."}
```

Editable fields for `/api/shipments/update`: `chequeAmount`, `refundDate`, `refundStatus` (per row) and
`telexStatus`, `paymentStatus` (applied to every row sharing the BL).

## Troubleshooting

- `SAFECUBE_API is missing`: set the secret (see above) and redeploy, or add it to `.env` for local runs.
- `401/403`: check the key is valid and has access to the Container Tracking API.
- `429`: wait before retrying; avoid repeated requests for the same BL.
- No results: verify the BL and try Auto-detect if a carrier was selected.
- Tracking data is only as fresh as the carrier's published events; it is not live GPS.
