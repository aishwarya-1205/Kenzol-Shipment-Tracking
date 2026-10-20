# Kenzol - Shipping Tracking Backend

FastAPI backend for the React/Vite frontend in `frontend/`. The backend reads `SAFECUBE_API` from the project-root `.env` file and calls the SafeCube/Sinay Container Tracking API.

## 1. Expected project layout

```text
kenzol-demo/
├── backend/
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   ├── package.json
│   └── vite.config.js
├── venv/
└── .env
```

The `.env` file should be in the `kenzol-demo` root, one level above `backend/`:

```env
SAFECUBE_API=your_real_api_key_here
```

Do not commit `.env` to Git. Do not put the API key in React/Vite variables such as `VITE_SAFECUBE_API`.

## 2. Install dependencies (Windows PowerShell)

From the `kenzol-demo` project root:

```powershell
.\venv\Scripts\Activate.ps1
python -m pip install -r .\backend\requirements.txt
```

If you do not have a virtual environment yet:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r .\backend\requirements.txt
```

## 3. Start the backend

From the project root:

```powershell
python -m uvicorn main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

Then check:
- Health: http://127.0.0.1:8000/api/health
- API docs: http://127.0.0.1:8000/docs
- Verified carrier/sealine list from provider: http://127.0.0.1:8000/api/sealines

Keep this terminal open.

## 4. Start the frontend in another terminal

```powershell
cd frontend
npm run dev
```

Open the Vite URL printed in the terminal, usually http://localhost:5173.

The included Vite proxy should forward `/api/*` calls to `http://127.0.0.1:8000`.

## API endpoint used by the frontend

```http
GET /api/track?bl_number=YOUR_BL_NUMBER
GET /api/track?bl_number=YOUR_BL_NUMBER&carrier=Maersk
```

Carrier values accepted by the backend: `MSC`, `Hapag-Lloyd`, `CMA CGM`, `Maersk`, and `MCL` only when `MCL_SCAC` is configured with a verified code. Leaving the carrier blank enables provider auto-detection.

## Excel endpoints

```http
POST /api/update-excel?bl_number=...   # write tracking data into the workbook
GET  /api/excel                        # workbook summary + register rows (Excel register view)
GET  /api/excel/download               # download the current workbook (.xlsx)
```

## Important carrier-code note

The API expects the provider's 4-letter sealine/SCAC code. Defaults in `main.py` are MSCU, HLCU, CMDU and MAEU. MCL's code is intentionally not guessed. Use `/api/sealines` to check the provider's official list; if you verify the right code, add it to the root `.env`:

```env
MCL_SCAC=VERIFIED_CODE
```

Restart the backend after changing `.env`.

## Troubleshooting

- `SAFECUBE_API is missing`: confirm the variable is in the root `.env`, spelled exactly `SAFECUBE_API`, then restart the backend.
- `401/403`: check that the key is valid and has access to Container Tracking API.
- `429`: wait before retrying; avoid repeated requests for the same BL.
- No results: verify the BL and try Auto-detect if a carrier was selected.
- If the frontend cannot connect, make sure both terminals are running and Vite's proxy points to port 8000.
- Shipment data is only as fresh as the provider/carrier data. Refreshing does not guarantee live GPS updates.
