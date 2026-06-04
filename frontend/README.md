# Summa — Frontend

Next.js 14 dashboard (static export) reading the Supabase warehouse. Read-only:
all writes happen in the backend pipeline; the browser uses the anon key with
SELECT-only access under RLS.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3000 (Turbopack)
```

If the dev server hangs and the project lives inside OneDrive, pause OneDrive
sync for the project folder — its file locking interferes with Turbopack's watcher.

## Build

```bash
npm run build      # static export → ./out  (output: 'export' is set for production)
```

## Deploy to Cloudflare Pages

Cloudflare Pages serves the static export directly — no server runtime.

1. **Connect the repo** in the Cloudflare dashboard → Workers & Pages → Create → Pages → connect to Git.
2. **Build settings:**
   - Framework preset: **Next.js (Static HTML Export)** — or set manually:
   - Build command: `npm run build`
   - Build output directory: `out`
   - Root directory: `frontend`
3. **Environment variables** (Production *and* Preview):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy. Every push to the connected branch rebuilds and republishes.

These two vars are public by design (anon key, RLS-guarded). The backend's
`service_role` key is never used by the frontend and must not be set here.
