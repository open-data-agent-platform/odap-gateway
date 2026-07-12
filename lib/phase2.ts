import { validateBigQuerySql, type SafetyCheck } from "./copilot-engine";

export type ReleaseEnvironment = "dev" | "staging" | "canary" | "production";
export type ReleaseStatus = "healthy" | "watching" | "paused";
export type FeatureFlagStatus = "enabled" | "guarded" | "paused";
export type QueryRunStatus = "approved" | "needs_approval" | "blocked";

export type ReleaseTrack = {
  environment: ReleaseEnvironment;
  label: string;
  status: ReleaseStatus;
  trafficPercent: number;
  buildId: string;
  gitSha: string;
  owner: string;
  checks: string[];
};

export type Phase2FeatureFlag = {
  id: string;
  name: string;
  description: string;
  status: FeatureFlagStatus;
  environment: ReleaseEnvironment;
  rollout: number;
  owner: string;
  updatedAt: string;
};

export type WorkspaceAccess = {
  workspace: string;
  owner: string;
  plan: "Free" | "Pro" | "Team";
  runAccess: "allowlisted" | "review" | "blocked";
};

export type QueryRunPreview = {
  status: QueryRunStatus;
  gateLabel: string;
  scannedBytes: number;
  estimatedCostUsd: number;
  expectedRuntimeMs: number;
  referencedTables: string[];
  projectedColumns: number;
  checks: SafetyCheck[];
  mode?: "live" | "simulated";
  configured?: boolean;
  runId?: string;
  persisted?: boolean;
  jobReference?: {
    projectId?: string;
    location?: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

export type ReviewQueueItem = {
  id: string;
  workspace: string;
  queryType: string;
  status: QueryRunStatus;
  estimatedCostUsd: number;
  scannedBytes: number;
  submittedAt: string;
};

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_TIB = 1024 ** 4;
const BIGQUERY_SIMULATED_COST_PER_TIB = 5;

export const releaseTracks: ReleaseTrack[] = [
  {
    environment: "dev",
    label: "Develop anytime",
    status: "healthy",
    trafficPercent: 0,
    buildId: "local-phase2",
    gitSha: "workspace",
    owner: "Codex",
    checks: ["lint", "typecheck", "unit tests"]
  },
  {
    environment: "staging",
    label: "Automatic test gate",
    status: "healthy",
    trafficPercent: 0,
    buildId: "stg-20260620",
    gitSha: "phase2",
    owner: "Release",
    checks: ["build", "health smoke", "SQL validator regression"]
  },
  {
    environment: "canary",
    label: "Gray release",
    status: "watching",
    trafficPercent: 5,
    buildId: "canary-20260620",
    gitSha: "phase2",
    owner: "Data Ops",
    checks: ["workspace allowlist", "cost budget", "error budget"]
  },
  {
    environment: "production",
    label: "Stable public traffic",
    status: "healthy",
    trafficPercent: 95,
    buildId: "prod-20260620",
    gitSha: "phase1",
    owner: "Release",
    checks: ["last healthy deployment", "rollback target", "prompt version lock"]
  }
];

export const phase2FeatureFlags: Phase2FeatureFlag[] = [
  {
    id: "bigquery-run-gate",
    name: "BigQuery run gate",
    description: "Dry-run cost check before any live execution path is enabled.",
    status: "guarded",
    environment: "canary",
    rollout: 5,
    owner: "Data Ops",
    updatedAt: "2026-06-20"
  },
  {
    id: "schema-admin",
    name: "Schema admin",
    description: "Manage tables, fields, and workspace schema allowlists.",
    status: "enabled",
    environment: "staging",
    rollout: 100,
    owner: "Product",
    updatedAt: "2026-06-20"
  },
  {
    id: "release-console",
    name: "Release console",
    description: "Track checks, canary traffic, and rollback targets.",
    status: "enabled",
    environment: "staging",
    rollout: 100,
    owner: "Release",
    updatedAt: "2026-06-20"
  }
];

export const workspaceAllowlist: WorkspaceAccess[] = [
  {
    workspace: "demo",
    owner: "Data Team",
    plan: "Team",
    runAccess: "allowlisted"
  },
  {
    workspace: "marketing",
    owner: "Growth",
    plan: "Pro",
    runAccess: "review"
  },
  {
    workspace: "sandbox",
    owner: "Learning",
    plan: "Free",
    runAccess: "blocked"
  }
];

export const reviewQueue: ReviewQueueItem[] = [
  {
    id: "run-1027",
    workspace: "demo",
    queryType: "Revenue rollup",
    status: "approved",
    estimatedCostUsd: 0.02,
    scannedBytes: 240 * BYTES_PER_MB,
    submittedAt: "2 min ago"
  },
  {
    id: "run-1026",
    workspace: "marketing",
    queryType: "Campaign sessions",
    status: "needs_approval",
    estimatedCostUsd: 0.18,
    scannedBytes: 1900 * BYTES_PER_MB,
    submittedAt: "9 min ago"
  },
  {
    id: "run-1025",
    workspace: "sandbox",
    queryType: "Unsafe DDL",
    status: "blocked",
    estimatedCostUsd: 0,
    scannedBytes: 0,
    submittedAt: "18 min ago"
  }
];

export function estimateDryRun(sql: string): QueryRunPreview {
  const checks = validateBigQuerySql(sql);
  const destructiveCheck = checks.find(
    (check) => check.label === "No destructive operations"
  );
  const costCheck = checks.find((check) => check.label === "Cost within limits");
  const referencedTables = extractReferencedTables(sql);
  const projectedColumns = countProjectedColumns(sql);
  const blocked = destructiveCheck?.status === "warn";
  const bounded = costCheck?.status === "pass";
  const scanMb = blocked
    ? 0
    : estimateScanMegabytes({
        bounded,
        projectedColumns,
        tableCount: referencedTables.length || 1
      });
  const scannedBytes = Math.round(scanMb * BYTES_PER_MB);
  const estimatedCostUsd = Number(
    ((scannedBytes / BYTES_PER_TIB) * BIGQUERY_SIMULATED_COST_PER_TIB).toFixed(4)
  );
  const expectedRuntimeMs = blocked ? 0 : Math.round(900 + scanMb * 5);
  const status: QueryRunStatus = blocked
    ? "blocked"
    : bounded
      ? "approved"
      : "needs_approval";

  return {
    status,
    gateLabel: getGateLabel(status),
    scannedBytes,
    estimatedCostUsd,
    expectedRuntimeMs,
    referencedTables,
    projectedColumns,
    checks
  };
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * BYTES_PER_MB) {
    return `${(bytes / (1024 * BYTES_PER_MB)).toFixed(1)} GB`;
  }

  return `${Math.round(bytes / BYTES_PER_MB)} MB`;
}

export function formatCost(cost: number) {
  if (cost > 0 && cost < 0.01) {
    return "< $0.01";
  }

  return `$${cost.toFixed(2)}`;
}

export function getPhase2Health() {
  return {
    ok: true,
    service: "odap-gateway",
    phase: "phase-2",
    deployment: {
      model: "develop-anytime-auto-test-gray-release-fast-rollback",
      current: "canary",
      rollbackTarget: "prod-20260620"
    },
    checks: [
      "copilot-engine",
      "dry-run-gate",
      "oauth-session",
      "admin-console",
      "release-tracks"
    ]
  };
}

export function getPublicHealth() {
  return {
    ok: true,
    service: "odap-gateway"
  };
}

export function getPhase3Health() {
  const phase2 = getPhase2Health();

  return {
    ...phase2,
    phase: "phase-3",
    checks: [
      ...phase2.checks,
      "admin-rbac",
      "d1-admin-store",
      "audit-log",
      "bigquery-dry-run",
      "query-run-audit",
      "run-review-approval",
      "admin-route-hardening",
      "run-review-detail",
      "bigquery-config-status"
    ]
  };
}

export function getPhase4Health() {
  const phase3 = getPhase3Health();

  return {
    ...phase3,
    phase: "phase-4",
    checks: [
      ...phase3.checks,
      "schema-catalog",
      "schema-field-policy",
      "workspace-schema-admin",
      "schema-policy-dry-run",
      "workspace-table-allowlist",
      "pii-dry-run-block",
      "bigquery-schema-import",
      "information-schema-sync",
      "admin-user-management",
      "admin-settings-console"
    ]
  };
}

function extractReferencedTables(sql: string) {
  const stripped = stripExtractExpressions(sql);
  const tables = Array.from(
    stripped.matchAll(/\b(?:FROM|JOIN)\s+`?([\w.-]+)`?/gi),
    (match) => match[1]
  );

  return Array.from(new Set(tables));
}

function stripExtractExpressions(sql: string) {
  return sql.replace(/\bEXTRACT\s*\([^)]*\bFROM\b[^)]*\)/gi, " ");
}

function countProjectedColumns(sql: string) {
  const selectMatch = sql.match(/\bSELECT\b([\s\S]+?)\bFROM\b/i);
  if (!selectMatch) {
    return 0;
  }

  const projection = selectMatch[1];
  if (projection.includes("*")) {
    return 8;
  }

  return projection
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function estimateScanMegabytes({
  bounded,
  projectedColumns,
  tableCount
}: {
  bounded: boolean;
  projectedColumns: number;
  tableCount: number;
}) {
  const base = bounded ? 240 : 1840;
  const tableCost = Math.max(0, tableCount - 1) * 180;
  const columnCost = Math.max(0, projectedColumns - 3) * 36;

  return base + tableCost + columnCost;
}

export function getGateLabel(status: QueryRunStatus) {
  return {
    approved: "Dry run approved",
    needs_approval: "Admin approval required",
    blocked: "Blocked by safety policy"
  }[status];
}
