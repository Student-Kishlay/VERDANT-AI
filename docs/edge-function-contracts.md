# Edge Function Contracts

Per Master Prompt §5.5 — written before implementing so the frontend can be
built against a stable contract. Implemented today as Express routes in
`server/app.js` (the mock backend); the request/response shapes below are
exactly what the real InsForge Edge Functions (`clean-dataset`,
`detect-columns`) should expose, so migrating later is a lift-and-shift of
logic, not a redesign.

Every response uses the shared envelope:

```json
// success
{ "ok": true, "data": { ... } }

// error
{ "ok": false, "error": { "code": "INVALID_FILE_TYPE", "message": "..." } }
```

## `clean-dataset`

Implemented as `POST /api/datasets/upload` (multipart form: `workspace_id`,
`file`).

**Request** (target edge-function shape): `{ storage_path, workspace_id, file_hash }`
— in the mock, the file itself is uploaded directly rather than referencing a
pre-uploaded storage path, since there's no separate "upload to storage, then
trigger processing" step yet.

**Response:**

```json
{
  "ok": true,
  "data": {
    "dataset": {
      "id": "uuid",
      "workspace_id": "uuid",
      "file_name": "sales.csv",
      "row_count": 10,
      "column_count": 5,
      "status": "ready",
      "failure_reason": null,
      "cleaning_summary": {
        "normalized_columns": ["order_date", "revenue", "..."],
        "rows_removed_empty": 1,
        "duplicates_removed": 1,
        "date_columns": ["order_date"],
        "numeric_columns": ["revenue", "quantity"],
        "missing_filled": { "revenue": 2 },
        "final_row_count": 10,
        "final_column_count": 5
      },
      "methodology_version": 1,
      "uploaded_at": "2026-01-01T00:00:00.000Z",
      "columns": [
        { "column_name": "revenue", "detected_role": "revenue", "confidence": 1, "user_override": null, "effective_role": "revenue" }
      ],
      "preview_rows": [{ "order_date": "2024-01-01", "revenue": 100 }]
    },
    "alreadyExists": false
  }
}
```

**Error codes:** `INVALID_INPUT`, `FORBIDDEN` (not a workspace member),
`INVALID_FILE_TYPE`, `FILE_TOO_LARGE`, `ROW_LIMIT_EXCEEDED`, `PARSE_ERROR`.
A dataset that fails *after* being created (e.g. cleans down to zero rows)
does not return an HTTP error — the request succeeds and the dataset's own
`status` is `'failed'` with a `failure_reason`, matching the
processing/ready/failed state machine in §5.1.

**Idempotency:** identical `(workspace_id, file content)` returns the existing
dataset with `alreadyExists: true` instead of creating a duplicate.

## `detect-columns`

Implemented as `GET /api/datasets/:id/columns` (read) and
`POST /api/datasets/:id/columns/:column_name/override` (write). Detection
itself runs automatically as part of `clean-dataset`/upload — there's no
separate "trigger detection" call — but overrides are a distinct endpoint so
the frontend can persist a fix without re-uploading.

**`GET` response:**

```json
{ "ok": true, "data": { "columns": [
  { "column_name": "region", "detected_role": "region", "confidence": 1, "user_override": null, "effective_role": "region" }
] } }
```

**`POST` request:** `{ "role": "category" }` (or `{ "role": null }` to clear
an override). **Response:** `{ "ok": true, "data": { "column": { ... } } }`.

`effective_role` is `user_override ?? detected_role` — every downstream
consumer (KPIs, forecasts, RFM — Milestones 4+) should read `effective_role`,
never `detected_role` directly, so a manual fix actually takes precedence
everywhere per §6.

## Supporting routes (not in §5.5, added for Milestone 3)

- `GET /api/config` — public, unauthenticated; every `.env`-driven value the
  client legitimately needs, and **never** a secret (`groqApiKey` is
  explicitly stripped before the response — see the security note in
  Milestone 6's history). Current shape:
  `{ maxUploadFileSizeMb, maxUploadRowCount, allowedFileTypes,
  anomalyContaminationRate, aiProvider, groqModel, chartGroundingThreshold,
  aiChatMaxMessagesPerWorkspacePerHour, aiChatMaxContextTokens,
  defaultShareLinkExpiryDays }`. This list grew across Milestones 5c/6/7 as
  each added its own configurable value — check `DEFAULT_CONFIG` in
  `server/app.js` directly if this drifts again.
- `GET /api/datasets?workspace_id=...` — list datasets in a workspace.
- `GET /api/datasets/:id` — fetch one (used for upload-status polling and the sidebar's active-dataset indicator).
- `DELETE /api/datasets/:id` — remove a dataset, its rows, column maps, and stored file.

## `compute-kpis`

Implemented as `GET /api/datasets/:id/kpis?start_date=&end_date=&region=` — the
§5.5 template shows this as a request body (`{ dataset_id, date_range?, region? }`);
adapted to query params on a GET here, consistent with how the other
dataset-scoped read routes work in this mock. `dataset_id` comes from the URL,
not the body.

**Response (available):**

```json
{ "ok": true, "data": { "kpis": {
  "available": true,
  "total_revenue": 5500,
  "total_orders": 10,
  "avg_order_value": 550,
  "active_customers": 9,
  "revenue_trend": [{ "date": "2024-02-01", "revenue": 100 }],
  "category_mix": [{ "category": "Grocery", "revenue": 2500 }],
  "available_regions": ["East", "North", "South", "West"],
  "methodology_version": 1
} } }
```

**Response (missing required columns)** — no HTTP error; the dataset is
readable, it just can't produce KPIs yet:

```json
{ "ok": true, "data": { "kpis": { "available": false, "missing": ["revenue"] } } }
```

Filtering (date range + region) happens exactly once, inside `computeKpis`
(`server/pipeline/compute-kpis.js`) — the route passes every row straight
through with no pre/post filtering of its own, so "server-side recompute" is
structurally guaranteed rather than asserted. `total_orders` counts distinct
values of the `order`-role column if one was detected/overridden, otherwise
each row counts as one order. `active_customers` is always a distinct count
of the `customer`-role column — this is the metric Milestone 4's acceptance
criteria calls out as broken in the original (it was stuck at a row-count-like
value regardless of repeat customers).

**Error codes:** `NOT_FOUND` (not a member / doesn't exist), `NOT_READY`
(dataset status isn't `'ready'` yet).

## `forecast-revenue`

Implemented as `GET /api/datasets/:id/forecast?horizon_days=7|30|90` — same
GET-query-param adaptation as `compute-kpis`; `horizon_days` is validated
server-side against exactly `[7, 30, 90]`.

**Response (available):**

```json
{ "ok": true, "data": { "forecast": {
  "available": true,
  "historical": [{ "date": "2024-02-01", "revenue": 100 }],
  "series": [{ "date": "2024-02-11", "predicted_revenue": 640 }],
  "horizon_days": 7,
  "methodology_version": 1
} } }
```

**Response (missing required columns)** — same shape as `compute-kpis`'s
unavailable case: `{ "available": false, "missing": ["revenue"] }`.

**Methodology (§8), one concrete choice where the spec underspecifies the
recursive part:** daily revenue is aggregated into a *dense* series — every
calendar day from first to last sale, zero-filled for gap days, not just the
days that had sales — then a degree-1 least-squares line is fit over that
series. The moving-average term is the average of the last `min(7, H)`
historical days. **(v2)** The two signals are blended once into a single
level anchor at the last historical day —
`anchor = 0.6 × linear_trend(last_day) + 0.4 × moving_average` — and every
future day extrapolates from that anchor at the fitted slope:
`predicted_revenue = max(0, anchor + slope × k)` for the k-th future day.
(v1 held the moving-average term flat across the whole horizon and
re-blended it into every future day, which diluted the fitted slope to 60%
of its true value — worse at longer horizons. v2 keeps the same blend as a
one-time smoothing of the *starting level* without damping the *growth
rate*.) Every call to this endpoint **appends** a new row to the
`forecasts` table (`server/db.js#createForecast`) rather than overwriting the
previous one — per §9/§10's methodology-versioning intent, this table is an
append-only log.

**Error codes:** `NOT_FOUND`, `NOT_READY`, `INVALID_INPUT` (unsupported
`horizon_days`).

## `segment-customers`

Implemented as `GET /api/datasets/:id/segments` (no request body/params —
always recomputes over the full dataset).

**Response (available):**

```json
{ "ok": true, "data": { "segmentation": {
  "available": true,
  "segments": [{
    "customer_key": "C1", "recency_days": 2, "frequency": 5, "monetary": 950,
    "recency_score": 5, "frequency_score": 5, "monetary_score": 5,
    "rfm_segment": "Champions", "methodology_version": 1
  }],
  "summary_by_label": [{ "segment": "Champions", "size": 1, "avg_revenue": 950, "avg_recency": 2 }],
  "methodology_version": 1
} } }
```

**Response (missing required columns)** — same `{ available: false, missing }`
shape as `compute-kpis`/`forecast-revenue`; `segment-customers` additionally
requires the `customer` role (KPIs/forecast only need `date` + `revenue`).

**Methodology (§9), concrete choices where the spec leaves the mechanics
open:** per customer, `frequency` = row count, `monetary` = revenue sum,
`recency_days` = days between the dataset's max transaction date and that
customer's own max transaction date (derived from the data, not wall-clock
time). Each of R/F/M is quantile-bucketed 1-5 via one shared ascending
`quantileScore` helper (ties broken by customer key for determinism) — for
recency the value fed in is negated first, so "fewest days since last
purchase" still maps to the highest score. Scores map to one of the six
labels via a priority-ordered rule table (see
`server/pipeline/segment-customers.js#classify`): Champions
(R≥4,F≥4,M≥4) → Loyal (R≥3,F≥4) → New Customers (R≥4,F≤2) → At Risk
(R≤2, F≥3 or M≥3) → Lost (R≤2,F≤2,M≤2) → Potential (everything else).

**Recompute semantics:** unlike `forecast-revenue` (an append-only log of
point-in-time projections), segments represent the dataset's *current*
classification — each call **replaces** the full set via
`server/db.js#setSegments`, the same replace-all pattern already used for
`column_maps`, so a methodology change can never leave a mixed old/new set.

**Error codes:** `NOT_FOUND`, `NOT_READY`.

## `detect-anomalies`

Implemented as `GET /api/datasets/:id/anomalies` (no request params — always
recomputes over the full dataset, `ANOMALY_CONTAMINATION_RATE` from `.env`
via `GET /api/config`).

**Response (available):**

```json
{ "ok": true, "data": { "anomalies": {
  "available": true,
  "flagged_rows": [{
    "row_index": 95, "anomaly_score": 0.7125,
    "values": { "revenue": 3000, "quantity": 10 }
  }],
  "contamination_rate": 0.05,
  "methodology_version": 1,
  "total_rows": 100
} } }
```

`values` and `total_rows` are added by the route (`server/app.js`) for the
client's convenience — the pipeline module itself (and what gets persisted
to the `anomalies` table) only carries `row_index`/`anomaly_score`, matching
the target schema in `db/schema.sql`.

**Response (missing required columns):** `{ "available": false, "missing": ["revenue"] }`
— `revenue` is the only hard requirement; `quantity` is used as a second
feature automatically if that role is present, per §10.

**Methodology (§10), built from scratch (no ML library) — the determinism
choice §10 doesn't address:** Isolation Forest is randomized by design
(random feature, random split value, random subsampling per tree), but the
acceptance bar demands the exact same rows flagged every run. Every random
decision in `server/pipeline/detect-anomalies.js` goes through a **fixed-seed
PRNG** (`mulberry32`) instead of `Math.random()` — still a genuine
randomized-tree ensemble, but the same dataset always produces the same
forest and the same flagged rows, consistent with the "same input → same
output" principle carried from the cleaning pipeline (§5). Parameters match
§10's explicit recommendation: 100 trees, subsample size `min(256, n)`,
standard path-length scoring with the leaf-size correction term. No fixed
numeric score threshold — the top `round(contamination_rate × n)` rows by
score are flagged, whatever that dataset's actual score distribution is.

**Recompute semantics:** replace-all via `server/db.js#setAnomalies`, same
rationale as `segment-customers` — a current classification, not a
historical log.

**Error codes:** `NOT_FOUND`, `NOT_READY`.

## `ai-chat`

Implemented as `GET /api/chat?workspace_id=&dataset_id=` (history) and
`POST /api/chat` (`{ workspace_id, dataset_id, message }`). No separate
`conversation_id` — the target schema's `chat_messages` table (§2) has none
either; `workspace_id` + `dataset_id` + `created_at` order **is** the
conversation.

**`POST` response:**

```json
{ "ok": true, "data": { "message": {
  "id": "uuid", "role": "assistant",
  "content": "\"Grocery\" is the top category by revenue ($2,500.00), out of 3 categories.",
  "chart_payload": { "chart_type": "bar", "label_column": "category", "value_column": "revenue",
                      "labels": ["Grocery", "Electronics", "Apparel"], "values": [2500, 1700, 1300] },
  "grounding_status": "verified",
  "created_at": "2026-01-01T00:00:00.000Z"
} } }
```

A rejected chart still returns `ok: true` with `chart_payload: null` and
`grounding_status: "rejected"` — the reply text itself carries the doc's
exact transparency notice appended: *"I couldn't confirm this chart against
your data, so I'm not showing it."*

**Provider (§0/§2.5 — "keep it swappable via `.env`"):** `AI_PROVIDER` +
`GROQ_API_KEY` select between `server/llm/mock-provider.js` (default — a
deterministic, keyword-matched responder that only ever reads real
aggregates, needing no credentials) and `server/llm/groq-provider.js` (a
real call to Groq's OpenAI-compatible chat-completions endpoint). **The Groq
path is implemented but has never been exercised against a live API key in
this build** — there is no InsForge project or Groq key available in this
environment. Confirm it actually works before relying on it.

**Chart grounding (§11, points 3-4) — the actual trust mechanism, and it
does not care which provider proposed the chart:**
`server/pipeline/verify-chart-grounding.js` re-checks every proposed
`labels` entry against the real values in `rows[chartPayload.label_column]`
— purely in code, never by asking the model to self-report. Below
`CHART_GROUNDING_THRESHOLD` (fraction of labels that verify), the chart is
dropped; the boundary itself (`verified_ratio === threshold`) still counts
as verified, matching the doc's literal "**fewer than** 60%" wording.

**Context summary (§11, point 1):** `server/pipeline/build-context-summary.js`
builds column stats/top-values/date-range/a 5-row sample, framed by a
`system_preamble` that tells whatever model reads it that dataset content is
DATA, not instructions (§11.1's prompt-injection concern) — sent as-is by
the Groq provider's system message; inert but present for the mock. Token
size is approximated as `chars/4` (no real tokenizer) and capped at
`AI_CHAT_MAX_CONTEXT_TOKENS` by trimming the sample rows, then the
categorical top-values, until it fits.

**Rate limiting (§11.1):** `server/rate-limiter.js`, an in-memory sliding
window keyed by `workspace_id`, checked before any work happens per request.
Deliberately ephemeral state (resets on restart) — acceptable for a mock
backend's abuse controls.

**Error codes:** `INVALID_INPUT`, `NOT_FOUND`, `NOT_READY`, `RATE_LIMITED`
(429, with the doc's exact user-facing message).

## `generate-report` + `manage-shares`

**Adaptation, stated up front:** §13 describes these as two functions, but
`report_shares` (§2) is the *only* table that stores a generated file's
`storage_path` — there is no separate "reports" table. So in this build,
**generating a report immediately issues its share link** — one `POST`
creates the file, stores it, and returns a `report_shares` row (token +
`DEFAULT_SHARE_LINK_EXPIRY_DAYS` expiry) in a single step. `manage-shares`'s
`refresh` and `revoke` then operate on that existing row. There's no
separate "issue" action — regenerating a report is the equivalent of a
fresh issue.

- `POST /api/datasets/:id/reports` (`{ report_type }`, one of
  `analytics_summary` | `sales_forecast` | `customer_segmentation` |
  `cleaned_dataset`) → `{ share: { id, workspace_id, dataset_id, report_type,
  url, created_at, expires_at, revoked, status } }`. `status` is derived
  (`active` | `expired` | `revoked`), not stored redundantly.
- `GET /api/datasets/:id/reports` — shares for one dataset (`/reports.html`).
- `GET /api/workspaces/:id/shares` — every share in a workspace (`/shares.html`).
- `POST /api/shares/:id/refresh` / `POST /api/shares/:id/revoke` —
  membership-checked against the share's own workspace.
- `GET /public/shares/:token` — **the one and only file-serving path**, no
  authentication. 404 if the token doesn't exist, 403 `REVOKED` /
  403 `EXPIRED` as appropriate, otherwise streams the file with the correct
  `Content-Type`. `share.url` in every response above is already this
  path — the client never sees or constructs a raw `storage_path`.

**Report content (§13, no chart-rendering library used):**
`server/pipeline/generate-report.js` builds `analytics_summary` /
`sales_forecast` / `customer_segmentation` as `pdf-lib` PDFs — title,
timestamp, and the relevant numbers as aligned text tables, reusing
`compute-kpis.js`/`forecast-revenue.js`/`segment-customers.js` directly
rather than recomputing their math. `cleaned_dataset` is an `exceljs` XLSX
export of the dataset's cleaned rows.

**Error codes:** `NOT_FOUND`, `NOT_READY`, `INVALID_INPUT` (bad
`report_type`), `GENERATE_FAILED`, and on the public route:
`NOT_FOUND` / `REVOKED` / `EXPIRED`.

## Team / Multi-User Workspaces (§12)

- `POST /api/workspaces` (`{ name }`) — any authenticated user; creates a
  `type: 'team'` workspace with the caller as `owner`.
- `GET /api/workspaces/:id/members` — any member →
  `{ members: [{ user_id, display_name, email, role, joined_at }],
  pending_invitations: [{ invited_email, status: 'pending', created_at }] }`.
- `POST /api/workspaces/:id/invitations` (`{ email }`) — **owner-only**. An
  email matching an existing user grants membership immediately →
  `{ status: 'joined', member: {...} }`; otherwise a `workspace_invitations`
  row is created → `{ status: 'pending', invitation: {...} }`, and converts
  to membership automatically the moment that exact email signs up (handled
  in `POST /api/auth/signup`). Inviting the same pending email twice reuses
  the existing invitation rather than duplicating it.

**Role enforcement added this milestone.** §12: *"owners can manage
membership, delete datasets, revoke share links; members can view data, run
analytics, and chat."* A `requireOwner(workspaceId, userId)` check
(`server/app.js`) was retrofitted onto exactly three existing routes:
`DELETE /api/datasets/:id`, `POST /api/shares/:id/refresh`, and
`POST /api/shares/:id/revoke` (refresh grouped with revoke — same
share-lifecycle character, though not separately named in §12). Every
other route stays open to any member — upload, KPIs, forecasts, segments,
anomalies, chat, and report *generation* are all "view data, run analytics"
in spirit, and §12 doesn't ask for them to be owner-restricted.

**Error codes:** `INVALID_INPUT`, `NOT_FOUND`, `FORBIDDEN` (403, non-owner
attempting an owner-only action).
