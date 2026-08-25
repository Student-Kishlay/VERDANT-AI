# Edge Functions (placeholder — Milestones 3+)

These directories mirror the InsForge Edge Function layout from the Master
Prompt (§16) and will hold the real TypeScript/Deno implementations once
Milestone 3 (Upload & Clean) begins:

- `clean-dataset/` — deterministic cleaning pipeline (§5)
- `detect-columns/` — column-role detection + override (§6)
- `compute-kpis/` — KPI dashboard (§7)
- `forecast-revenue/` — revenue forecasting (§8)
- `segment-customers/` — RFM segmentation (§9)
- `detect-anomalies/` — Isolation Forest (§10)
- `ai-chat/` — grounded AI chat (§11)
- `generate-report/` — PDF/XLSX generation (§13)
- `manage-shares/` — share-token lifecycle (§13)

For Milestones 1-2, all backend logic (auth + workspaces) lives in
`server/` (the local mock backend) instead — there is no dataset to operate
on yet, so none of these functions have logic to implement.
