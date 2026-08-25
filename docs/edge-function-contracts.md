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

- `GET /api/config` — `{ maxUploadFileSizeMb, maxUploadRowCount, allowedFileTypes }`, sourced from `.env`.
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
historical days, held **constant** across the whole forecast horizon (a flat
anchor); the linear term is what actually extrapolates forward.
`predicted_revenue = max(0, 0.6 × linear_trend + 0.4 × moving_average)` per
future day. Every call to this endpoint **appends** a new row to the
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
