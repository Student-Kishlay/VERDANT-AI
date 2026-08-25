# Architecture — current (mock) vs. target (InsForge)

## Current: local mock backend (Milestones 1-10 of 10)

```
Browser (public/, vanilla HTML/CSS/JS, no build step)
   │  fetch() via public/js/insforge-client.js
   ▼
server/app.js (Express)
 ├─ Auth/workspaces: signup, login, /me, list/switch/create workspaces,
 │  members, invitations                                          (§12)
 ├─ GET  /api/config  (public; every .env value the client needs, never a secret)
 ├─ POST /api/datasets/upload  ──► parse-spreadsheet.js
 │                                 clean-dataset.js         (§5)
 │                                 detect-columns.js        (§6)
 ├─ GET/DELETE /api/datasets/:id, column overrides
 ├─ GET  /api/datasets/:id/kpis        ──► compute-kpis.js       (§7)
 ├─ GET  /api/datasets/:id/forecast    ──► forecast-revenue.js   (§8)
 ├─ GET  /api/datasets/:id/segments    ──► segment-customers.js  (§9)
 ├─ GET  /api/datasets/:id/anomalies   ──► detect-anomalies.js   (§10)
 ├─ GET/POST /api/chat                 ──► build-context-summary.js,
 │                                         verify-chart-grounding.js,
 │                                         llm/ (mock + groq providers) (§11)
 ├─ POST /api/datasets/:id/reports     ──► generate-report.js    (§13)
 └─ GET/POST /api/shares/..., GET /public/shares/:token (unauthenticated)
   │                                    │                    │
   ▼                                    ▼                    ▼
server/db.js — JSON-file store    server/storage.js      server/rate-limiter.js
 └─ every table in db/schema.sql    (uploads + reports,   (in-memory, per-workspace,
    (subset actually used by         server/data/*)        AI Chat abuse control)
    the mock; same columns)
```

Every request that touches workspace data resolves the caller's identity from
the JWT (`requireAuth` in `server/app.js`) and filters strictly through
`workspace_members`, the same isolation boundary the real schema enforces via
Postgres Row-Level Security (see `db/schema.sql`) — with three routes
(`DELETE /api/datasets/:id`, share refresh/revoke) additionally requiring the
`owner` role, not just membership, per §12.

## Target: InsForge (once credentials exist)

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
