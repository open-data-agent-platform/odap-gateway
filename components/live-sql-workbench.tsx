"use client";

import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  Database,
  Gauge,
  LoaderCircle,
  Play,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TableProperties,
  WandSparkles
} from "lucide-react";
import { generateGoogleSql, validateGoogleSql } from "@/lib/copilot-engine";
import { schemaTables } from "@/lib/content";
import {
  estimateDryRun,
  formatBytes,
  formatCost,
  workspaceAllowlist,
  type QueryRunPreview
} from "@/lib/phase2";
import { cn } from "@/lib/utils";

type QueryDryRunApiResponse = {
  ok?: boolean;
  preview?: QueryRunPreview;
  runId?: string;
  persisted?: boolean;
  storageBinding?: "ODAP_GATEWAY_DB" | "DB" | null;
  code?: string;
  message?: string;
};

const sampleQuestion =
  "Show weekly revenue and order count for the last 8 weeks, grouped by acquisition channel";

const initialResult = generateGoogleSql(sampleQuestion);
const initialSql = initialResult.sql ?? "";

const fallbackSql = `SELECT
  DATE_TRUNC(order_date, WEEK) AS week_start,
  acquisition_channel,
  SUM(revenue) AS weekly_revenue,
  COUNT(*) AS order_count
FROM \`analytics.orders\`
WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
  AND order_date < CURRENT_DATE()
  AND status = 'completed'
GROUP BY week_start, acquisition_channel
ORDER BY week_start DESC, weekly_revenue DESC;`;

export function LiveSqlWorkbench({ compact = false }: { compact?: boolean }) {
  const [question, setQuestion] = useState(sampleQuestion);
  const [sqlDraft, setSqlDraft] = useState(initialSql || fallbackSql);
  const [workspace, setWorkspace] = useState("analytics");
  const [queryType, setQueryType] = useState("Revenue rollup");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDryRunning, setIsDryRunning] = useState(false);
  const [runPreview, setRunPreview] = useState<QueryRunPreview | null>(null);

  const sql = sqlDraft.trim() ? sqlDraft : fallbackSql;
  const localEstimate = useMemo(() => estimateDryRun(sql), [sql]);
  const checks = runPreview?.checks ?? validateGoogleSql(sql);
  const usedFields = useMemo(() => extractUsedFields(sql), [sql]);
  const approvedChecks = checks.filter((check) => check.status === "pass").length;
  const riskChecks = checks.length - approvedChecks;

  function generateSql() {
    setIsGenerating(true);
    window.setTimeout(() => {
      const nextResult = generateGoogleSql(question);
      setSqlDraft(nextResult.sql ?? fallbackSql);
      setRunPreview(null);
      setIsGenerating(false);
      showToast("Generated SQL draft");
    }, 420);
  }

  async function dryRunQuery() {
    if (!sql.trim()) {
      showToast("Add SQL before dry-run");
      return;
    }

    setIsDryRunning(true);
    try {
      const response = await fetch("/api/query/dry-run", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sql,
          workspace,
          queryType: queryType.trim() || "SQL dry run"
        })
      });
      const body = (await response.json().catch(() => null)) as
        | QueryDryRunApiResponse
        | null;

      if (!response.ok || !body?.preview) {
        throw new Error(body?.message ?? "Dry-run API request failed.");
      }

      setRunPreview(body.preview);
      showToast(getDryRunToast(body.preview));
    } catch (error) {
      const preview = {
        ...estimateDryRun(sql),
        mode: "simulated",
        configured: false,
        error: {
          code: "frontend_fallback",
          message:
            error instanceof Error
              ? error.message
              : "Backend dry-run API is unavailable."
        }
      } satisfies QueryRunPreview;

      setRunPreview(preview);
      showToast("Local simulated dry run");
    } finally {
      setIsDryRunning(false);
    }
  }

  return (
    <section className={cn("app-shell-bg", compact ? "py-6" : "py-6 lg:py-8")}>
      <div className="relative mx-auto grid max-w-[1480px] gap-5 px-4 sm:px-6 xl:grid-cols-[minmax(0,1fr)_390px] lg:px-8">
        <div className="min-w-0 space-y-5">
          <section className="glass-panel glow-border min-w-0 overflow-hidden rounded-lg">
            <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <WandSparkles className="h-5 w-5 text-[#4285f4]" />
                <h1 className="text-base font-semibold text-slate-50">
                  Real SQL Workspace
                </h1>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs sm:min-w-[360px]">
                <RunMetric label="Workspace" value={workspace} />
                <RunMetric
                  label="Checks"
                  value={`${approvedChecks}/${checks.length}`}
                />
                <RunMetric label="Risks" value={String(riskChecks)} />
              </div>
            </div>

            <div className="grid gap-4 p-5">
              <label className="grid gap-2 text-xs font-semibold text-slate-400">
                Business question
                <textarea
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  className="focus-ring min-h-[92px] w-full resize-y rounded-lg border border-white/10 bg-[#05070d] px-4 py-3 text-sm font-medium leading-7 text-slate-100 transition hover:border-[#4285f4]/[0.35] placeholder:text-slate-700"
                />
              </label>

              <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
                <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
                  Workspace
                  <select
                    value={workspace}
                    onChange={(event) => {
                      setWorkspace(event.currentTarget.value);
                      setRunPreview(null);
                    }}
                    className="focus-ring h-10 rounded-lg border border-white/10 bg-[#05070d] px-3 text-sm font-semibold text-slate-100 outline-none"
                  >
                    {workspaceAllowlist.map((item) => (
                      <option key={item.workspace} value={item.workspace}>
                        {item.workspace}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
                  Query type
                  <input
                    value={queryType}
                    onChange={(event) => setQueryType(event.currentTarget.value)}
                    className="focus-ring h-10 rounded-lg border border-white/10 bg-[#05070d] px-3 text-sm font-semibold text-slate-100 outline-none placeholder:text-slate-700"
                    placeholder="Revenue rollup"
                  />
                </label>
                <button
                  type="button"
                  onClick={generateSql}
                  disabled={isGenerating || !question.trim()}
                  className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#4285f4] px-4 text-sm font-semibold text-white shadow-[0_0_28px_rgba(66,133,244,0.32)] transition hover:bg-blue-500 disabled:cursor-wait disabled:opacity-70"
                >
                  {isGenerating ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Generate SQL
                </button>
              </div>
            </div>
          </section>

          <section className="glass-panel min-w-0 overflow-hidden rounded-lg">
            <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <Code2 className="h-5 w-5 text-[#a855f7]" />
                <h2 className="text-base font-semibold text-slate-50">
                  Editable SQL
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs font-medium text-slate-500">
                <button
                  type="button"
                  title="Copy SQL"
                  onClick={() => void copySql(sql)}
                  className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2 transition hover:bg-white/[0.06] hover:text-slate-200"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
                <button
                  type="button"
                  title="Reset generated SQL"
                  onClick={() => {
                    setSqlDraft(initialSql || fallbackSql);
                    setRunPreview(null);
                  }}
                  className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2 transition hover:bg-white/[0.06] hover:text-slate-200"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
                <button
                  type="button"
                  title="BigQuery dry-run"
                  onClick={() => void dryRunQuery()}
                  disabled={isDryRunning}
                  className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-[#34a853]/10 px-2 font-semibold text-[#4ade80] transition hover:bg-[#34a853]/15 disabled:cursor-wait disabled:opacity-70"
                >
                  {isDryRunning ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Dry run
                </button>
              </div>
            </div>

            <SqlEditor
              sql={sqlDraft}
              onChange={(value) => {
                setSqlDraft(value);
                setRunPreview(null);
              }}
            />
            <RunGatePreview preview={runPreview} />

            <div className="flex flex-col gap-3 border-t border-white/10 px-5 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <InlineMetric
                  icon={Gauge}
                  label="Est. cost"
                  value={formatCost(
                    runPreview?.estimatedCostUsd ?? localEstimate.estimatedCostUsd
                  )}
                />
                <InlineMetric
                  icon={Database}
                  label="Scan"
                  value={formatBytes(
                    runPreview?.scannedBytes ?? localEstimate.scannedBytes
                  )}
                />
                <InlineMetric
                  icon={Clock3}
                  label="Runtime"
                  value={`${(
                    (runPreview?.expectedRuntimeMs ??
                      localEstimate.expectedRuntimeMs) / 1000
                  ).toFixed(1)}s`}
                />
              </div>
              <span>BigQuery Standard SQL</span>
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-5">
          <SafetyChecksPanel checks={checks} />
          <SchemaContext usedFields={usedFields} />
        </aside>
      </div>
    </section>
  );
}

function SqlEditor({
  sql,
  onChange
}: {
  sql: string;
  onChange: (value: string) => void;
}) {
  const lineCount = Math.max(16, sql.split("\n").length);
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1);

  return (
    <div className="grid h-[430px] min-h-[430px] grid-cols-[48px_minmax(0,1fr)] overflow-hidden bg-[#090c14]">
      <pre className="sql-code select-none overflow-hidden border-r border-white/[0.06] bg-black/[0.16] px-3 py-4 text-right text-sm leading-6 text-slate-700">
        {lineNumbers.join("\n")}
      </pre>
      <textarea
        value={sql}
        onChange={(event) => onChange(event.currentTarget.value)}
        spellCheck={false}
        className="sql-code h-full w-full resize-none overflow-auto border-0 bg-transparent px-4 py-4 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-700"
        placeholder="SELECT ... FROM `project.dataset.table` WHERE ..."
      />
    </div>
  );
}

function SafetyChecksPanel({ checks }: { checks: QueryRunPreview["checks"] }) {
  const hasWarnings = checks.some((check) => check.status === "warn");

  return (
    <section className="glass-panel overflow-hidden rounded-lg">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-[#34a853]" />
          <h2 className="text-base font-semibold text-slate-50">
            Safety Checks
          </h2>
        </div>
        <span
          className={cn(
            "rounded border px-2 py-1 text-[11px] font-semibold",
            hasWarnings
              ? "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]"
              : "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]"
          )}
        >
          {hasWarnings ? "Review" : "Ready"}
        </span>
      </div>
      <ul className="space-y-3 p-4">
        {checks.map((check) => {
          const passed = check.status === "pass";

          return (
            <li
              key={check.label}
              className={cn(
                "rounded-lg border px-4 py-3",
                passed
                  ? "border-[#34a853]/[0.12] bg-[#34a853]/[0.08]"
                  : "border-[#fbbc05]/[0.18] bg-[#fbbc05]/[0.08]"
              )}
            >
              <div className="flex gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                    passed
                      ? "border-[#34a853]/[0.45] bg-[#34a853]/10 text-[#34a853]"
                      : "border-[#fbbc05]/[0.45] bg-[#fbbc05]/10 text-[#fbbc05]"
                  )}
                >
                  {passed ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-100">
                    {check.label}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">
                    {check.detail}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RunGatePreview({ preview }: { preview: QueryRunPreview | null }) {
  if (!preview) {
    return null;
  }

  const modeLabel =
    preview.mode === "live" ? "BigQuery live dry run" : "Simulated dry run";
  const persistenceLabel = preview.persisted
    ? `Audit saved as ${preview.runId}`
    : "Audit not persisted";
  const statusClassName = {
    approved: "border-[#34a853]/25 bg-[#34a853]/[0.08] text-[#4ade80]",
    needs_approval: "border-[#fbbc05]/25 bg-[#fbbc05]/[0.08] text-[#facc15]",
    blocked: "border-[#ea4335]/25 bg-[#ea4335]/[0.08] text-[#f87171]"
  }[preview.status];
  const jobRef = preview.jobReference?.projectId
    ? `${preview.jobReference.projectId}${
        preview.jobReference.location ? ` / ${preview.jobReference.location}` : ""
      }`
    : null;

  return (
    <div className="border-t border-white/10 bg-[#070b13] px-5 py-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
              statusClassName
            )}
          >
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-100">
                Execution Gate
              </p>
              <span
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-semibold",
                  statusClassName
                )}
              >
                {preview.gateLabel}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {modeLabel} / {persistenceLabel}
              {jobRef ? ` / ${jobRef}` : ""}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {preview.referencedTables.join(", ") || "No table detected"} /{" "}
              {preview.projectedColumns || "unknown"} projected columns
              {preview.error ? ` / ${preview.error.message}` : ""}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs sm:min-w-[360px]">
          <RunMetric label="Cost" value={formatCost(preview.estimatedCostUsd)} />
          <RunMetric label="Scan" value={formatBytes(preview.scannedBytes)} />
          <RunMetric
            label="Runtime"
            value={`${(preview.expectedRuntimeMs / 1000).toFixed(1)}s`}
          />
        </div>
      </div>
    </div>
  );
}

function SchemaContext({ usedFields }: { usedFields: Set<string> }) {
  const table = schemaTables[0];

  return (
    <section className="glass-panel overflow-hidden rounded-lg">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-3">
          <TableProperties className="h-5 w-5 text-[#22d3ee]" />
          <h2 className="text-base font-semibold text-slate-50">
            Schema Context
          </h2>
        </div>
        <span className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-500">
          {table.columnCount} cols
        </span>
      </div>

      <div className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-4 w-4 text-[#4285f4]" />
          <p className="sql-code break-all font-semibold text-[#60a5fa]">
            {table.name}
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-black/[0.15]">
          {table.fields.map((field) => {
            const used = usedFields.has(field.name);

            return (
              <div
                key={field.name}
                className={cn(
                  "group flex items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-3 text-sm transition last:border-b-0 hover:bg-[#4285f4]/10",
                  used ? "text-slate-100" : "text-slate-600"
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full transition group-hover:bg-[#4285f4]",
                      used
                        ? "bg-[#4285f4] shadow-[0_0_10px_rgba(66,133,244,0.9)]"
                        : field.key
                          ? "bg-[#fbbc05]/[0.7]"
                          : "bg-slate-700"
                    )}
                  />
                  <span className="sql-code truncate">{field.name}</span>
                </span>
                <span className="rounded px-2 py-1 text-[11px] font-semibold ring-1 ring-white/[0.08]">
                  {field.type}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 py-2">
      <span className="block text-[11px] font-medium text-slate-600">
        {label}
      </span>
      <span className="mt-1 block truncate font-semibold text-slate-200">
        {value}
      </span>
    </span>
  );
}

function InlineMetric({
  icon: Icon,
  label,
  value
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-slate-600" />
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

function extractUsedFields(sql: string) {
  const normalized = sql.toLowerCase();
  const fields = new Set<string>();

  schemaTables.forEach((table) => {
    table.fields.forEach((field) => {
      if (normalized.includes(field.name.toLowerCase())) {
        fields.add(field.name);
      }
    });
  });

  return fields;
}

async function copySql(sql: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(sql);
    } else {
      fallbackCopy(sql);
    }
    showToast("SQL copied");
  } catch {
    fallbackCopy(sql);
    showToast("SQL copied");
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function getDryRunToast(preview: QueryRunPreview) {
  if (preview.status === "blocked") {
    return "Run blocked by policy";
  }

  if (preview.status === "needs_approval") {
    return preview.persisted
      ? "Run queued for admin approval"
      : "Run needs admin approval";
  }

  return preview.mode === "live"
    ? "Live BigQuery dry run approved"
    : "Simulated dry run approved";
}

function showToast(message: string) {
  const existing = document.getElementById("odap-gateway-toast");
  existing?.remove();

  const toast = document.createElement("div");
  toast.id = "odap-gateway-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    top: "80px",
    right: "16px",
    zIndex: "9999",
    border: "1px solid rgba(52, 168, 83, 0.35)",
    borderRadius: "8px",
    background: "rgba(8, 19, 34, 0.96)",
    boxShadow: "0 0 30px rgba(52, 168, 83, 0.25)",
    color: "#f8fafc",
    fontSize: "14px",
    fontWeight: "700",
    padding: "12px 16px",
    backdropFilter: "blur(14px)"
  });

  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 1800);
}
