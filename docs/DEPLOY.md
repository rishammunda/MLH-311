# Deploying to DigitalOcean App Platform

The checked-in [`.do/app.yaml`](../.do/app.yaml) defines the Python API, Vite static
site, PostgreSQL binding, health check, and `/api` routing in one app.

## First deployment

1. Push the repository to `rishammunda/MLH-311` on GitHub. If the slug or production
   branch changes, update both `github` blocks in `.do/app.yaml`.
2. Install and authenticate `doctl`, then validate and create the app:

   ```bash
   doctl auth init
   doctl apps spec validate .do/app.yaml
   doctl apps create --spec .do/app.yaml
   ```

   The same spec can be imported through **Apps → Create App → App Spec** in the
   DigitalOcean control panel.
3. In the backend component's environment settings, set
   `DIGITALOCEAN_INFERENCE_KEY` (a Gradient AI model access key) to the real value
   and keep it encrypted. `DO_MODEL` and `SF_APP_TOKEN` are optional.
4. Leave `ENABLE_SIMULATE_SURGE=0` in production. Set it to `1` only for a
   controlled demo, then redeploy.
5. After deployment, verify these URLs using the assigned app hostname:

   ```bash
   curl https://YOUR-APP.ondigitalocean.app/api/health
   curl 'https://YOUR-APP.ondigitalocean.app/api/cases?limit=5'
   ```

Ingress removes the `/api` prefix before forwarding to FastAPI. The backend also
accepts `/api/...` internally, so changing ingress to preserve the prefix later
will not break the API. The frontend uses `VITE_API_BASE=/api`.

## Managed PostgreSQL

The committed spec provisions a small development PostgreSQL database so a new
contributor can deploy it without already owning a database cluster. For the
production Managed PostgreSQL requested by the architecture:

1. Create a Managed PostgreSQL cluster in the `sfo` region, or select an existing
   cluster under the app's **Create/Attach Database** flow.
2. Attach the app as a trusted source.
3. Export the app spec from DigitalOcean. Its database block will contain the
   real cluster name and should look like:

   ```yaml
   databases:
     - name: cases-db
       engine: PG
       version: "16"
       production: true
       cluster_name: your-managed-cluster-name
   ```

4. Keep the backend binding as
   `DATABASE_URL=${cases-db.DATABASE_URL}`. App Platform injects the credentials;
   never commit a literal connection string.
5. Validate the exported spec before applying it:

   ```bash
   doctl apps spec validate .do/app.yaml
   doctl apps update YOUR_APP_ID --spec .do/app.yaml
   ```

The service creates its `cases` table and priority index on startup. No separate
migration command is required for this demo schema.

## Rollback and local fallback

If PostgreSQL is unavailable locally, omit `DATABASE_URL`; the backend uses
`backend/sf311.db`. To force an isolated in-memory database, set
`DATABASE_URL=sqlite:///:memory:`. Both adapters use the same parameterized store
API and clustering logic.
