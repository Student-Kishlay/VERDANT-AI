# Verdant BI

Zero-configuration, self-service BI platform: upload a sales spreadsheet, get
cleaned data, KPI dashboards, forecasts, RFM segmentation, anomaly detection,
and a grounded AI chat assistant. Full spec: `Verdant_BI_Master_Prompt_v2.md`.

## Current status: Milestones 1-10 of 10 (against the local mock backend)

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
- Responsiveness + accessibility pass (§17 Milestone 9): audited all 10
  pages at 1440/768/375px plus keyboard focus visibility. Found and fixed
  two real issues rather than assuming the design was already compliant:
  (1) the primary button/badge/logo color (`--color-accent`, `#16a673`) and
  the light-blue brand color (`--color-brand-blue`, `#5b8dbe`) both failed
  WCAG AA for white button text (3.12:1 / 3.50:1 against the 4.5:1
  requirement) — darkened both slightly (now 4.63:1 / 4.64:1), which also
  fixed the success-pill text contrast as a side effect; (2) a genuine
  layout bug where the sidebar's wrapper element reserved ~284px of empty
  vertical space above the header on some pages at mobile widths, found via
  manual screenshot review (the automated horizontal-overflow check alone
  wouldn't have caught it) and fixed by removing the wrapper's box
  entirely (`display: contents`) at the mobile breakpoint.

- Testing + docs (§17 Milestone 10, the final one): closed the one real gap
  found in the §15 checklist audit — a permanent static guard
  (`tests/xss-guard.test.js`) that fails the build if any frontend script
  ever assigns to `.innerHTML`, since that's the actual invariant that makes
  "renders as inert text everywhere" (dashboard/chat/reports) hold by
  construction, and the prior XSS checks were all one-off scripts deleted
  after use. Corrected two accuracy drifts in
  `docs/edge-function-contracts.md` (a `GET /api/config` shape documented
  back in Milestone 3, since grown by three later milestones; two response
  shapes missing fields the actual code returns) and added the missing
  Deployment section below. A consolidated single-session Playwright pass
  (signup → upload → dashboard → all 3 insights tabs → chat → reports →
  shares → team) and a dedicated dashboard/report XSS check both passed
  with zero console errors.

**What "10 of 10" actually means here — read this before assuming more than
is true:** every milestone's acceptance criteria are met **against the
local mock backend** (`server/`), verified by 86 automated tests plus a
live browser pass each milestone. Three things are explicitly *not* done:
(1) no real InsForge project is connected — everything InsForge-specific
(§0.5's MCP-driven setup, the actual Postgres/Auth/Storage/Edge Function
deployment, §18's deploy steps) is documented and ready but never executed;
(2) the real Groq LLM provider (`server/llm/groq-provider.js`) is
implemented but has never been called with a live API key; (3)
`functions/` (the real InsForge Edge Function targets) are still
placeholders — the equivalent logic lives in `server/pipeline/` today.
`docs/architecture.md` and the Deployment section below spell out exactly
what changes when any of these three become real.

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

86 tests across `tests/*.test.js`, mapped to the master prompt's §15
checklist:

- **Auth & isolation** (`auth.test.js`, `isolation.test.js`, and a
  cross-workspace check in every other test file): signup/login/session,
  wrong-password/duplicate-email rejection, a user outside a workspace
  gets 404/zero rows on every dataset-scoped route, not just one.
- **Cleaning pipeline & column detection** (`pipeline.test.js`): exact
  hand-computed cleaning-summary output on a fixture, determinism (same
  input twice → identical output), column-role detection + override
  precedence.
- **Upload edge cases** (`upload.test.js`): idempotent re-upload, oversized/
  wrong-type/over-row-limit rejection, malformed CSV → `status: 'failed'`
  with a reason (not a hang).
- **Analytics** (`pipeline.test.js`, `dashboard.test.js`, `insights.test.js`):
  KPI totals against hand-computed values including a live server-side
  filter check, non-negative forecast values (including a case that
  actually crosses zero and gets floored), all 6 RFM labels present and
  each customer's label matching a hand-computed table, Isolation Forest
  flagging exactly 5 designed outliers (no false positives/negatives).
- **Chart grounding** (`pipeline.test.js`): a fabricated <60%-real-labels
  spec is rejected, a fully-grounded spec verifies, the 60% boundary itself
  passes (matching the doc's literal "fewer than 60%" wording).
- **AI Chat** (`chat.test.js`): grounded answers match real data exactly,
  a category-breakdown question returns a verified chart, conversation
  history persists in order, the per-workspace rate limit trips at the
  configured threshold, `GET /api/config` never leaks the Groq API key.
- **Reports & sharing** (`reports.test.js`): every generated file's magic
  bytes are checked (so "opens without corruption" is verified, not
  assumed), revoking/expiring a share 403s the next access, refreshing
  issues a working new token and 404s the old one.
- **Team/roles** (`team.test.js`): immediate membership for an existing
  invitee, pending-invitation-to-membership conversion on signup, and that
  a non-owner member is rejected from the three owner-only actions (delete
  dataset, refresh/revoke a share).
- **XSS** (`dom-safe.test.js`, `pipeline.test.js`, `chat.test.js`,
  `xss-guard.test.js`): the `escapeHtml()` helper neutralizes an injected
  payload, the cleaning pipeline stores a malicious value as-is (sanitizing
  is a render-time concern, not a storage-time mutation), a chat message
  containing a payload round-trips unexecuted, and a static guard fails the
  build if any frontend script ever assigns to `.innerHTML` — the one rule
  that makes "renders as inert text everywhere" (dashboard/chat/reports)
  hold by construction rather than by remembering to check each page.

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

## Deployment (§18 — not run live in this build)

No InsForge project is connected in this environment, so none of this has
actually been executed — it's documented precisely so it's ready to run the
moment a real project exists, rather than skipped because it's untested.
Per §18, InsForge's hosting deploys the static frontend through a managed
Vercel deployment under the hood (one InsForge project maps 1:1 to one
Vercel deployment):

```bash
npx @insforge/cli                                    # confirm current CLI setup against InsForge's docs first — §0.5
npx @insforge/cli deployments env set PROJECT_URL=... ANON_KEY=...  # browser-safe values only — never the service-role key
npx @insforge/cli deployments deploy ./public         # public/ has no build step, deploy it as-is
```

That gives a live URL at `https://<appkey>.insforge.site` immediately —
Edge Functions and Postgres are already live the moment they're created in
InsForge, no separate deploy step for backend logic. A custom domain is
optional (add it in the InsForge dashboard, point the CNAME it returns) and
newer, so verify current behavior against InsForge's docs before relying on
it. Before migrating, re-run `npm test`'s equivalent Edge Function tests and
the manual Milestone 1-10 acceptance passes against the **live** URL, not
just localhost — CORS/env misconfigurations often only surface once
deployed, per §18's own note. If a separate Vercel-native deployment is
preferred instead, `public/` can be deployed there directly with no
changes (still no build step) — just add that domain to InsForge's allowed
CORS origins so the frontend can still reach the InsForge backend.

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
