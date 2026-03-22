# Save to Brain

This repo contains:

- `backend/` Node + Express API
- `extension/` Chrome MV3 extension

## Quick Start

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill DATABASE_URL, API_KEY, GOOGLE_API_KEY
psql "$DATABASE_URL" -f schema.sql
npm run start
```

### Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and choose `extension/`
4. Open the extension options page and set:
   - API Base URL (e.g. `http://localhost:8787`)
   - API Key (matches backend `API_KEY`)

Open ChatGPT and click **Save to Brain**.
