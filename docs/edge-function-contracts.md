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

## Supporting routes (not in §5.5, added for this milestone)

- `GET /api/config` — `{ maxUploadFileSizeMb, maxUploadRowCount, allowedFileTypes }`, sourced from `.env`.
- `GET /api/datasets?workspace_id=...` — list datasets in a workspace.
- `GET /api/datasets/:id` — fetch one (used for upload-status polling and the sidebar's active-dataset indicator).
- `DELETE /api/datasets/:id` — remove a dataset, its rows, column maps, and stored file.
