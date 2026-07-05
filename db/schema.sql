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

INSERT OR IGNORE INTO feature_flags
  (id, name, description, status, environment, rollout, owner, updated_at)
VALUES
  (
    'bigquery-run-gate',
    'BigQuery run gate',
    'Dry-run cost check before any live execution path is enabled.',
    'guarded',
    'canary',
    5,
    'Data Ops',
    '2026-06-20'
  ),
  (
    'schema-admin',
    'Schema admin',
    'Manage tables, fields, and workspace schema allowlists.',
    'enabled',
    'staging',
    100,
    'Product',
    '2026-06-20'
  ),
  (
    'release-console',
    'Release console',
    'Track checks, canary traffic, and rollback targets.',
    'enabled',
    'staging',
    100,
    'Release',
    '2026-06-20'
  );

INSERT OR IGNORE INTO workspaces
  (workspace, owner, plan, run_access, updated_at)
VALUES
  ('analytics', 'Data Team', 'Team', 'allowlisted', '2026-06-20T00:00:00.000Z'),
  ('marketing', 'Growth', 'Pro', 'review', '2026-06-20T00:00:00.000Z'),
  ('sandbox', 'Learning', 'Free', 'blocked', '2026-06-20T00:00:00.000Z');

INSERT OR IGNORE INTO schema_tables
  (id, workspace, table_name, description, row_count, updated_at)
VALUES
  (
    'table-analytics-orders',
    'analytics',
    'analytics.orders',
    'Order facts for revenue, channel, and status analysis.',
    8420000,
    '2026-06-22T00:00:00.000Z'
  ),
  (
    'table-analytics-customers',
    'analytics',
    'analytics.customers',
    'Customer profile dimensions used for cohort and plan reporting.',
    1240000,
    '2026-06-22T00:00:00.000Z'
  ),
  (
    'table-analytics-events',
    'analytics',
    'analytics.events',
    'Product event stream for funnel, session, and behavior queries.',
    178000000,
    '2026-06-22T00:00:00.000Z'
  );

INSERT OR IGNORE INTO schema_fields
  (id, table_id, field_name, field_type, mode, description, pii, queryable, used_in_examples, updated_at)
VALUES
  ('table-analytics-orders-order-id', 'table-analytics-orders', 'order_id', 'INT64', 'REQUIRED', 'Primary join key for this table.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-orders-order-date', 'table-analytics-orders', 'order_date', 'DATE', 'NULLABLE', 'Order date column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-orders-acquisition-channel', 'table-analytics-orders', 'acquisition_channel', 'STRING', 'NULLABLE', 'Acquisition channel column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-orders-revenue', 'table-analytics-orders', 'revenue', 'FLOAT64', 'NULLABLE', 'Revenue column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-orders-status', 'table-analytics-orders', 'status', 'STRING', 'NULLABLE', 'Status column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-orders-customer-id', 'table-analytics-orders', 'customer_id', 'INT64', 'NULLABLE', 'Customer id column.', 1, 0, 0, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-customers-customer-id', 'table-analytics-customers', 'customer_id', 'INT64', 'REQUIRED', 'Primary join key for this table.', 1, 0, 0, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-customers-created-at', 'table-analytics-customers', 'created_at', 'TIMESTAMP', 'NULLABLE', 'Created at column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-customers-plan', 'table-analytics-customers', 'plan', 'STRING', 'NULLABLE', 'Plan column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-customers-country', 'table-analytics-customers', 'country', 'STRING', 'NULLABLE', 'Country column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-events-event-time', 'table-analytics-events', 'event_time', 'TIMESTAMP', 'NULLABLE', 'Event time column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-events-event-name', 'table-analytics-events', 'event_name', 'STRING', 'NULLABLE', 'Event name column.', 0, 1, 1, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-events-user-id', 'table-analytics-events', 'user_id', 'STRING', 'NULLABLE', 'User id column.', 1, 0, 0, '2026-06-22T00:00:00.000Z'),
  ('table-analytics-events-session-id', 'table-analytics-events', 'session_id', 'STRING', 'NULLABLE', 'Session id column.', 1, 0, 0, '2026-06-22T00:00:00.000Z');

INSERT OR IGNORE INTO docs_feedback
  (
    id,
    kind,
    topic,
    author_name,
    author_email,
    message,
    status,
    answer_text,
    answered_by,
    answered_at,
    created_at
  )
VALUES
  (
    'seed-docs-question-1',
    'question',
    'BigQuery dry-run',
    'Data analyst',
    NULL,
    'Can I see the estimated bytes before asking an admin to approve a generated query?',
    'approved',
    'Yes. Dry-run results show estimated bytes, cost, runtime, referenced tables, and safety checks before an admin approves a run.',
    'Platform admin',
    '2026-06-22T00:00:00.000Z',
    '2026-06-22T00:00:00.000Z'
  ),
  (
    'seed-docs-comment-1',
    'comment',
    'Schema catalog',
    'Workspace owner',
    NULL,
    'The field-level queryable and PII toggles make the approval workflow much easier to explain to analysts.',
    'approved',
    NULL,
    NULL,
    NULL,
    '2026-06-22T00:00:00.000Z'
  );

INSERT OR IGNORE INTO run_reviews
  (id, workspace, query_type, status, estimated_cost_usd, scanned_bytes, submitted_at)
VALUES
  ('run-1027', 'analytics', 'Revenue rollup', 'approved', 0.02, 251658240, '2 min ago'),
  ('run-1026', 'marketing', 'Campaign sessions', 'needs_approval', 0.18, 1992294400, '9 min ago'),
  ('run-1025', 'sandbox', 'Unsafe DDL', 'blocked', 0, 0, '18 min ago');
