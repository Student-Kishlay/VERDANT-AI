# Architecture — current (hybrid) state

As of the InsForge migration (see `AGENTS.md`, `db/insforge-schema.sql`),
this app is **partway** between the original local mock and a fully
InsForge-native app. This section documents what's actually true today —
update it again as more of `server/` gets ported.

```
Browser (public/, vanilla HTML/CSS/JS, no build step)
   │
   ├─ Auth: real InsForge Auth, via public/js/insforge-client.js calling
   │  @insforge/sdk directly (createClient loaded from an esm.sh CDN URL —
   │  no bundler). Signup/login/session/logout never touch server/app.js.
   │
   ├─ KPIs / Forecast / Segments / Anomalies: real InsForge Edge Functions
   │  (functions/compute-kpis, forecast-revenue, segment-customers,
   │  detect-anomalies — deployed, live). The client calls
   │  insforge.functions.invoke() directly; each function queries Postgres
   │  with the caller's own access token, so Row-Level Security — not a
   │  manual membership check — is what scopes access.
   │
   └─ Everything else (dataset upload/parsing/cleaning, column overrides,
      AI chat, report generation, sharing, team/workspace management) still
      goes through server/app.js (Express), which itself now reads/writes
      the same real InsForge Postgres (via server/insforge.js, an admin-key
      REST client — server/db.js has no local JSON-file persistence left)
      and real InsForge Storage buckets (raw-uploads, reports — via
      server/storage.js) instead of local disk.
```

## Real InsForge resources in use

- **Postgres**: every table in `db/insforge-schema.sql` (adapted from the
  original `db/schema.sql` — no custom `users` table; InsForge's own
  `auth.users` is used instead, referenced via `auth.uid()` in every RLS
  policy). Two real-world fixes applied post-launch, both still noted
  inline in `db/insforge-schema.sql`:
  - `datasets` was missing `failure_reason`/`methodology_version` (the app
    needed them; the original schema draft didn't have them).
  - `segments` was missing `recency_days`/`frequency`/`monetary` (the pure
    RFM pipeline computes them; the schema only had the 1-5 scores).
  - A **SECURITY DEFINER** helper, `is_workspace_member(ws_id)`, exists
    specifically to break an infinite-recursion bug: a naive RLS policy on
    `workspace_members` that queries `workspace_members` (with RLS active)
    to check membership recurses forever. Every policy that checks
    workspace membership calls this function instead of inlining the
    subquery. This only ever surfaces when a request is made with a real
    user token (as the edge functions do) — server-side admin-key access
    bypasses RLS entirely, which is why it went unnoticed until Phase 3.
- **Auth**: email/password, email verification currently **disabled**
  project-wide (`insforge.toml`: `require_email_verification = false`) —
  SMTP isn't configured, so verification emails can't send. Re-enable once
  a real sender is set up.
- **Storage**: two private buckets, `raw-uploads` and `reports`, accessed
  server-side with the admin key (`server/storage.js`).
- **Edge Functions**: `compute-kpis`, `forecast-revenue`,
  `segment-customers`, `detect-anomalies` — deployed and live. Each is a
  single self-contained Deno file (no relative imports to the rest of the
  repo; the pure algorithm is inlined, ported from the matching
  `server/pipeline/*.js`, which is still the source of truth for the
  Express-side duplicate and for `pipeline.test.js`'s unit coverage).
- **AI Gateway**: **not used** — provisioning it requires a paid InsForge
  plan; this project is on the free plan. AI chat still runs on Groq
  directly (`server/llm/groq-provider.js`, `AI_PROVIDER=groq` in `.env`).

## What's NOT done (in case work resumes here)

- `server/app.js` still owns: `/api/auth/me` (session bootstrap — creates
  the first personal workspace, accepts pending invites), all dataset
  upload/CRUD routes, `/api/chat`, report generation + sharing, and
  team/workspace management. None of these have an edge-function
  equivalent yet.
- Porting the rest would mean: multipart file upload handling in Deno,
  `exceljs`/`pdf-lib` report generation in Deno (untested there — these are
  the two pipeline files with actual npm dependencies), and a
  Postgres-backed replacement for the in-memory chat rate limiter
  (`server/rate-limiter.js`), since a stateless edge function can't hold
  that state between invocations the way Express currently does.
- Only once all of that is ported does "delete `server/`, deploy `public/`
  standalone via `insforge deployments deploy`" become safe — attempting it
  before then would break uploads, chat, reports, sharing, and team
  management for anyone using the deployed frontend.
