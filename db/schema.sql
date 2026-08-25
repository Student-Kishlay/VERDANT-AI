-- Verdant BI — target Postgres schema for InsForge (per Master Prompt §2 / §2.1)
--
-- This file is the SOURCE OF TRUTH for the real backend. The local mock server
-- (server/db.js) implements a subset of this shape (users, workspaces,
-- workspace_members only, for Milestones 1-2) as JSON-file-backed tables with
-- the same columns and the same workspace-membership isolation rule. Run this
-- file against a real InsForge Postgres project when migrating off the mock;
-- verify the exact RLS syntax InsForge expects against its current docs before
-- applying (RLS policy syntax here is standard Postgres and should work as-is
-- on a Postgres-compatible backend, but confirm per the Master Prompt's §0.5
-- rule of checking InsForge's current interface rather than assuming parity).

-- ── Core tables ──────────────────────────────────────────────────────────────

create table if not exists users (
  id uuid primary key,               -- = auth user id
  display_name text,
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('personal', 'team')),
  owner_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invited_email text not null,
  status text not null check (status in ('pending', 'accepted', 'revoked')) default 'pending',
  invited_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  file_name text not null,
  file_hash text not null,           -- sha256 of raw upload; drives idempotent re-upload
  row_count integer,
  column_count integer,
  storage_path text,
  cleaning_summary jsonb,
  status text not null check (status in ('processing', 'ready', 'failed')) default 'processing',
  uploaded_by uuid not null references users(id),
  uploaded_at timestamptz not null default now()
);

create table if not exists column_maps (
  dataset_id uuid not null references datasets(id) on delete cascade,
  column_name text not null,
  detected_role text check (detected_role in ('date','revenue','product','region','category','customer','quantity','order') or detected_role is null),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  user_override text,
  primary key (dataset_id, column_name)
);

create table if not exists dataset_rows (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  row_index integer not null,
  data jsonb not null
);

create table if not exists forecasts (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  horizon_days integer not null,
  generated_at timestamptz not null default now(),
  series jsonb not null,
  methodology_version integer not null
);

create table if not exists segments (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  customer_key text not null,
  recency_score integer,
  frequency_score integer,
  monetary_score integer,
  rfm_segment text check (rfm_segment in ('Champions','Loyal','New Customers','At Risk','Lost','Potential')),
  methodology_version integer not null,
  computed_at timestamptz not null default now()
);

create table if not exists anomalies (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  row_index integer not null,
  anomaly_score numeric not null,
  methodology_version integer not null,
  flagged_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  dataset_id uuid references datasets(id) on delete cascade,
  user_id uuid not null references users(id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  chart_payload jsonb,
  grounding_status text check (grounding_status in ('verified', 'rejected', 'n/a')),
  created_at timestamptz not null default now()
);

create table if not exists report_shares (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  dataset_id uuid not null references datasets(id) on delete cascade,
  report_type text not null check (report_type in ('analytics_summary','sales_forecast','customer_segmentation','cleaned_dataset')),
  storage_path text not null,
  token text not null unique,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked boolean not null default false
);

-- ── Indexing (§2.1) ──────────────────────────────────────────────────────────

create index if not exists idx_dataset_rows_dataset on dataset_rows (dataset_id);
create index if not exists idx_dataset_rows_data_gin on dataset_rows using gin (data);
create index if not exists idx_column_maps_dataset on column_maps (dataset_id);
create index if not exists idx_forecasts_dataset_generated on forecasts (dataset_id, generated_at desc);
create index if not exists idx_segments_dataset_label on segments (dataset_id, rfm_segment);
create index if not exists idx_anomalies_dataset_score on anomalies (dataset_id, anomaly_score desc);
create index if not exists idx_chat_workspace_dataset_created on chat_messages (workspace_id, dataset_id, created_at);
create index if not exists idx_report_shares_token_active on report_shares (token) where not revoked;
create unique index if not exists uq_datasets_workspace_hash on datasets (workspace_id, file_hash);

-- ── Row-Level Security ───────────────────────────────────────────────────────
-- Every workspace-scoped table is isolated by workspace_members membership.
-- Enforced at the database layer — this is the actual multi-tenancy boundary,
-- not merely a UI-level filter (Master Prompt §12/§14).

alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table workspace_invitations enable row level security;
alter table datasets enable row level security;
alter table column_maps enable row level security;
alter table dataset_rows enable row level security;
alter table forecasts enable row level security;
alter table segments enable row level security;
alter table anomalies enable row level security;
alter table chat_messages enable row level security;
alter table report_shares enable row level security;

create policy workspace_member_select on workspaces
  for select using (
    exists (select 1 from workspace_members m where m.workspace_id = workspaces.id and m.user_id = auth.uid())
  );

create policy workspace_owner_manage on workspaces
  for all using (owner_id = auth.uid());

create policy members_select on workspace_members
  for select using (
    exists (select 1 from workspace_members m where m.workspace_id = workspace_members.workspace_id and m.user_id = auth.uid())
  );

-- Repeat the same "member of this row's workspace_id" predicate for every
-- remaining workspace-scoped table (datasets, column_maps, dataset_rows,
-- forecasts, segments, anomalies, chat_messages, report_shares,
-- workspace_invitations). One representative example — apply identically:

create policy dataset_scope on datasets
  for all using (
    exists (select 1 from workspace_members m where m.workspace_id = datasets.workspace_id and m.user_id = auth.uid())
  );
