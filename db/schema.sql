CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  last_login_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  environment TEXT NOT NULL,
  rollout INTEGER NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  plan TEXT NOT NULL,
  run_access TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS run_reviews (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  query_type TEXT NOT NULL,
  status TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  scanned_bytes INTEGER NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  actor_email TEXT,
  sql TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  scanned_bytes INTEGER NOT NULL,
  expected_runtime_ms INTEGER NOT NULL,
  referenced_tables_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_tables (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  table_name TEXT NOT NULL,
  description TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace, table_name)
);

CREATE TABLE IF NOT EXISTS schema_fields (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  description TEXT NOT NULL,
  pii INTEGER NOT NULL,
  queryable INTEGER NOT NULL,
  used_in_examples INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(table_id, field_name)
);

CREATE TABLE IF NOT EXISTS docs_feedback (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  answer_text TEXT,
  answered_by TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL
);

-- Demonstration records belong to the non-persisted preview, not installation.
