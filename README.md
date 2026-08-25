# Verdant BI

Zero-configuration, self-service BI platform: upload a sales spreadsheet, get
cleaned data, KPI dashboards, forecasts, RFM segmentation, anomaly detection,
and a grounded AI chat assistant. Full spec: `Verdant_BI_Master_Prompt_v2.md`.

## Current status: Milestones 1 & 2 of 10

This build has no InsForge project/credentials connected yet, so it currently
runs against a **local mock backend** (`server/`) that implements the same
data model and isolation rules the real InsForge Postgres schema will
(`db/schema.sql`). See `docs/architecture.md` for the current-vs-target
architecture and exactly what changes when you connect a real InsForge
project.

Done so far:
- Auth (signup/login/session) with JWT, auto-provisioned personal workspace
  per user, workspace-membership isolation enforced server-side.
- Shared app shell (sidebar, workspace switcher, active-dataset indicator,
  user chip) rendered identically on all 10 pages.
- `login.html` and `index.html` are fully functional; the other 8 pages
  render the shared shell with an explicit empty state describing which
  later milestone builds them out.

Not yet built (Milestones 3-10): upload & cleaning pipeline, KPI dashboard,
forecasting/segmentation/anomaly detection, AI chat + chart grounding,
reports & sharing, team invitations, and the eventual InsForge migration.
Each is its own milestone with its own review checkpoint, per the master
prompt's own working rule (§0.5/§19) — don't assume anything past Milestone 2
is implemented.

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
they don't belong to), and the `escapeHtml()` XSS-safety helper.

## Project structure

```
verdant-bi/
├── public/            -- frontend: 10 pages, css/, js/ (incl. js/lib/dom-safe.js for §4.1 XSS safety)
├── server/            -- local mock backend standing in for InsForge (Milestones 1-2 only)
├── functions/         -- placeholders for the real InsForge Edge Functions (Milestone 3+)
├── db/schema.sql       -- target Postgres schema + indexes + RLS for real InsForge
├── tests/             -- node --test suite
├── docs/architecture.md
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
  `escapeHtml()` (`public/js/lib/dom-safe.js`) — never `innerHTML` — per §4.1.
  This is enforced from Milestone 1 onward so later milestones inherit the
  habit rather than retrofitting it.
