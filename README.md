# Verdant BI

Zero-configuration, self-service BI platform: upload a sales spreadsheet, get
cleaned data, KPI dashboards, forecasts, RFM segmentation, anomaly detection,
and a grounded AI chat assistant. Full spec: `Verdant_BI_Master_Prompt_v2.md`.

## Current status: Milestones 1-8 of 10

This build has no InsForge project/credentials connected yet, so it currently
runs against a **local mock backend** (`server/`) that implements the same
data model and isolation rules the real InsForge Postgres schema will
(`db/schema.sql`). See `docs/architecture.md` for the current-vs-target
architecture and exactly what changes when you connect a real InsForge
project.

Done so far:
- Auth (signup/login/session) with JWT, auto-provisioned personal workspace
  per user, workspace-membership isolation enforced server-side.
- Shared app shell (sidebar, workspace switcher, active-dataset indicator +
  delete action, user chip) rendered identically on all 10 pages.
- Upload & Clean (`/upload.html`): drag-drop CSV/XLSX upload, a deterministic
  cleaning pipeline (§5 — column normalization, empty/duplicate-row removal,
  date parsing, numeric coercion, missing-value imputation), column-role
  detection with manual override (§6), idempotent re-upload by content hash,
  and upload validation (type/size/row-count limits). See
  `docs/edge-function-contracts.md` for the `clean-dataset`/`detect-columns`
  request/response contracts.
- Dashboard (`/dashboard.html`): server-computed KPI cards (Total Revenue,
  Total Orders, Average Order Value, Active Customers), a Revenue Trend line
  chart and Category Mix bar chart (Chart.js via CDN), and a date-range +
  region filter bar that re-fetches from the server on every change rather
  than filtering a cached row set in the browser (§7).
- Insights → Sales Forecasting (`/insights.html`): a blended linear-trend +
  moving-average revenue forecast (§8), horizon-selectable (7/30/90 days),
  floored at zero, stored as an append-only log per dataset.
- Insights → Customer Segmentation (`/insights.html`): RFM scoring
  (Recency/Frequency/Monetary, quantile-bucketed 1-5) mapped to one of six
  segment labels (§9), surfaced as size/avg-revenue/avg-recency cards plus a
  customers-per-segment chart. Recomputes replace the prior segment set
  rather than accumulating duplicates.
- Insights → Anomaly Detection (`/insights.html`): an Isolation Forest built
  from scratch (§10, no ML library) over the revenue (+ quantity, if
  present) columns, flagging `ANOMALY_CONTAMINATION_RATE` of rows with no
  fixed numeric threshold. Uses a fixed-seed PRNG instead of `Math.random()`
  so the same dataset always flags the same rows — otherwise this
  genuinely-randomized algorithm couldn't meet a "same input → same output"
  bar. Surfaced as a summary line, a per-row anomaly-score chart, and a
  flagged-rows table.
- Insights (all three tabs — Forecasting, Segmentation, Anomaly Detection)
  load once per dataset and don't re-fetch on tab switches.
- AI Chat + Chart Grounding (`/chat.html`, §11): a conversation over the
  active dataset, answered by a deterministic, data-grounded **mock LLM
  provider** by default (`server/llm/mock-provider.js` — needs no
  credentials, never fabricates since it only reads real aggregates). Every
  chart either provider proposes is independently re-verified in code
  against real dataset rows (`server/pipeline/verify-chart-grounding.js`)
  before it's ever shown; a chart that fails verification is dropped and the
  reply carries the doc's exact transparency notice instead. Per-workspace
  rate limiting and an approximate context-token cap are both wired up
  (§11.1). **A real Groq provider is also implemented** (`server/llm/groq-provider.js`,
  selected via `AI_PROVIDER=groq` + `GROQ_API_KEY`) but has **not been
  tested against a live key** — there's no Groq or InsForge credential
  available in this environment. Verify it actually works before relying on
  it in production.
- Reports & Secure Sharing (`/reports.html`, `/shares.html`, §13): four
  report types — Analytics Summary, Sales Forecast, and Customer
  Segmentation as PDFs (`pdf-lib`, plain aligned-text tables rather than
  chart images — no chart-rendering dependency needed), and the cleaned
  dataset as an XLSX export (`exceljs`). Generating a report immediately
  issues its share link (one `report_shares` row covers both concerns, per
  the target schema); revoking or letting a link expire makes the public
  URL 403 on the next request, checked server-side — the raw storage path
  is never exposed to the client.
- Team / Multi-User Workspaces (`/team.html`, §12): create team
  workspaces; invite by email (immediate membership for an existing user,
  a pending invitation that auto-converts to membership the moment that
  exact email signs up otherwise). Added real **role enforcement** this
  milestone: deleting a dataset and refreshing/revoking a share link now
  require the `owner` role, not just membership — retrofitted onto the
  three existing routes §12 names as owner-only, checked server-side.
- Every page (`login.html`, `index.html`, `upload.html`, `dashboard.html`,
  `insights.html`, `chat.html`, `reports.html`, `shares.html`, `team.html`)
  is now fully functional. `profile.html` remains a stub (account info +
  upload/chat history — never explicitly scoped to a milestone in the
  master prompt's numbered list).

Not yet built (Milestone 9-10): a dedicated auth/security hardening pass,
the full §15 test suite as a single reviewed sweep, final docs, and the
eventual InsForge migration. Each is its own milestone with its own review
checkpoint, per the master prompt's own working rule (§0.5/§19) —
don't assume anything past Milestone 8 is implemented.

## Running it

```bash
npm install
cp .env.example .env   # edit JWT_SECRET at minimum
npm run dev             # starts the mock backend + serves public/ at :5175
```

Open http://localhost:5175/login.html, sign up, and you'll land on the home
page with the sidebar/workspace switcher/user chip working.

## Tests

```bash
npm test
```

Covers: signup → login → session flow, wrong-password/duplicate-email
rejection, workspace isolation (a user cannot see or switch into a workspace
they don't belong to), the `escapeHtml()` XSS-safety helper, the cleaning
pipeline's exact hand-computed output on a fixture, column-role detection,
and the upload endpoint (idempotent re-upload, size/type/row-count limits,
malformed-file failure state, cross-workspace isolation).

## Project structure

```
verdant-bi/
├── public/            -- frontend: 10 pages, css/, js/ (incl. js/lib/dom-safe.js for §4.1 XSS safety)
├── server/            -- local mock backend standing in for InsForge
│   ├── pipeline/       -- clean-dataset.js, detect-columns.js, parse-spreadsheet.js (§5/§6)
│   └── storage.js      -- stands in for InsForge Storage
├── functions/         -- placeholders for the real InsForge Edge Functions (Milestone 4+)
├── db/schema.sql       -- target Postgres schema + indexes + RLS for real InsForge
├── tests/             -- node --test suite + tests/fixtures/ (hand-computed CSV fixtures)
├── docs/
│   ├── architecture.md
│   └── edge-function-contracts.md
└── .env.example
```

## Migrating to real InsForge

See `docs/architecture.md` → "What changes when migrating off the mock." In
short: connect InsForge's MCP/CLI, confirm its current SDK/Edge Function
syntax against its live docs (don't assume parity with other BaaS
platforms), run `db/schema.sql`, swap `public/js/insforge-client.js`'s
internals for the real SDK, and implement the functions under `functions/`.
`server/` is retired at that point.

## Security notes

- Never commit `.env`. `JWT_SECRET` here is a mock-only concern (the real
  InsForge Auth handles JWT signing once migrated) — set it to a real random
  value even for local dev.
- All dataset/chat/user-derived strings must render via `textContent` or
  `escapeHtml()`/`el()` (`public/js/lib/dom-safe.js`) — never `innerHTML` —
  per §4.1. This is enforced from Milestone 1 onward so later milestones
  inherit the habit rather than retrofitting it.
- `.xlsx` parsing uses `exceljs`, not the `xlsx` (SheetJS) npm package — the
  npm-published `xlsx` has an unpatched high-severity prototype-pollution/
  ReDoS advisory, which matters here because it parses attacker-controlled
  uploads. `.csv` parsing is a small hand-rolled parser with no third-party
  dependency at all. `exceljs` currently carries a moderate advisory in its
  `uuid` sub-dependency (a buffer-bounds issue in code paths this app's
  read-only usage doesn't exercise); re-run `npm audit` periodically and
  swap it out if a cleaner alternative emerges.
