# Architecture — current (mock) vs. target (InsForge)

## Current: local mock backend (Milestones 1-3)

```
Browser (public/, vanilla HTML/CSS/JS, no build step)
   │  fetch() via public/js/insforge-client.js
   ▼
server/app.js (Express)
 ├─ POST /api/auth/signup, /api/auth/login   (bcrypt + JWT)
 ├─ GET  /api/auth/me
 ├─ GET  /api/workspaces
 ├─ POST /api/workspaces/:id/switch
 ├─ GET  /api/config
 ├─ POST /api/datasets/upload  ──► server/pipeline/parse-spreadsheet.js
 │                                 server/pipeline/clean-dataset.js   (§5)
 │                                 server/pipeline/detect-columns.js  (§6)
 ├─ GET  /api/datasets, /api/datasets/:id
 ├─ POST /api/datasets/:id/columns/:column_name/override
 └─ DELETE /api/datasets/:id
   │                                    │
   ▼                                    ▼
server/db.js — JSON-file store    server/storage.js — raw uploads on disk
 └─ users, workspaces,                 (server/data/uploads/)
    workspace_members, datasets,
    column_maps, dataset_rows
    (subset of db/schema.sql — the real target schema)
```

Every request that touches workspace data resolves the caller's identity from
the JWT (`requireAuth` in `server/app.js`) and filters strictly through
`workspace_members`, the same isolation boundary the real schema enforces via
Postgres Row-Level Security (see `db/schema.sql`).

## Target: InsForge (from Milestone 3 onward, once credentials exist)

```
Browser (same public/ code, unchanged)
   │  fetch() + InsForge JS SDK
   ▼
InsForge Auth ──────────────► JWT issued, stored client-side
   │
   ▼
InsForge Postgres (REST/SDK)          InsForge Edge Functions (TS/Deno)
 ├─ users, workspaces,                 ├─ clean-dataset
 │  workspace_members,                 ├─ detect-columns
 │  workspace_invitations              ├─ compute-kpis
 ├─ datasets, dataset_rows (JSONB)     ├─ forecast-revenue
 ├─ column_maps                        ├─ segment-customers
 ├─ forecasts, segments, anomalies     ├─ detect-anomalies
 ├─ chat_messages                      ├─ ai-chat
 └─ report_shares                      ├─ generate-report
                                        └─ manage-shares
   │
   ▼
InsForge S3-Compatible Storage ── raw uploads, generated PDF reports
   │
   ▼
InsForge AI Gateway ── LLM completions for AI Chat
```

## What changes when migrating off the mock

1. **`public/js/insforge-client.js`** — replace the internal `fetch()` calls
   with the real InsForge SDK client, confirmed against InsForge's current
   docs/MCP tools (per the Master Prompt's §0.5 rule — do not assume method
   names match this file or match other BaaS SDKs).
2. **`server/`** — retired. Auth, Postgres, and Storage become InsForge's
   responsibility; `functions/*` become real deployed Edge Functions instead
   of unused placeholders.
3. **`db/schema.sql`** — run against the real InsForge Postgres project. It
   already has the exact tables, indexes, and RLS policies this app expects;
   verify RLS policy syntax against InsForge's current interface before
   applying.
4. **Nothing in `public/*.html` or `public/css/`** needs to change — the
   frontend was built against the same request/response contracts either
   backend provides.
