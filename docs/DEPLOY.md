# Deploying to DigitalOcean

Two options. The App Platform path is the fastest for a hackathon.

## Option A — App Platform (recommended)

1. Push this repo to GitHub (`rishammunda/MLH-311`).
2. In the DO dashboard: **Apps → Create App → GitHub**, pick the repo/branch.
   (Or `doctl apps create --spec .do/app.yaml`.)
3. DO detects two components from [.do/app.yaml](../.do/app.yaml):
   - **backend** (Python service) — runs `uvicorn main:app`.
   - **frontend** (static site) — builds the Vite app to `dist/`.
4. Set **`ANTHROPIC_API_KEY`** as an encrypted env var on the backend component.
   (Optionally set `SF_APP_TOKEN`.)
5. Deploy. DO gives you a public URL like
   `https://sf311-live-triage-xxxxx.ondigitalocean.app`.

### One routing gotcha

`.do/app.yaml` puts the backend under `/api`, but the FastAPI routes are `/cases`,
`/health`, etc. Pick one:

- **Simplest:** change the backend route in `app.yaml` from `/api` to `/` and give the
  frontend its own component/app, OR
- Add an APIRouter prefix in `backend/main.py` (`APIRouter(prefix="/api")`) so routes
  become `/api/cases` and match the `/api` route.

Set the frontend's `VITE_API_BASE` to match whatever the backend is reachable at.

## Option B — Single Droplet + Docker Compose

If you'd rather run everything on one box:

1. Create a Droplet (Ubuntu, basic).
2. Install Docker + Compose.
3. Run the backend with `uvicorn` (or containerize it), serve the built frontend with any
   static host / nginx.
4. Point a domain or use the Droplet IP.

## Managed Postgres (optional, Raghav)

The store is currently in-memory. To persist:

1. Create a **DO Managed Postgres** database (provisioning takes a few minutes — start early).
2. Put the connection string in `DATABASE_URL`.
3. Swap the dict in `backend/store.py` for parameterized SQL behind the same
   `upsert` / `get_cases` functions. Keep queries parameterized (SQL-injection safety).
