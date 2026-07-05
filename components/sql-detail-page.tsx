import {
  Clock3,
  Code2,
  FileClock,
  GitBranch,
  MessageSquareText,
  RotateCcw,
  ShieldCheck
} from "lucide-react";
import { formatBytes, formatCost, reviewQueue } from "@/lib/phase2";

const versions = [
  {
    id: "ver_003",
    label: "Added channel grouping",
    author: "mira@company.com",
    createdAt: "2026-07-02 10:16"
  },
  {
    id: "ver_002",
    label: "Added partition filter",
    author: "mira@company.com",
    createdAt: "2026-07-02 10:08"
  },
  {
    id: "ver_001",
    label: "Initial AI draft",
    author: "mira@company.com",
    createdAt: "2026-07-02 09:58"
  }
];

const comments = [
  {
    author: "avery@company.com",
    body: "Please keep the rolling window at 8 weeks and avoid customer-level identifiers.",
    createdAt: "10:20"
  },
  {
    author: "mira@company.com",
    body: "Updated the WHERE clause and removed SELECT * from the generated draft.",
    createdAt: "10:25"
  }
];

const executionLogs = [
  "dry_run.created",
  "policy.checked",
  "approval.requested",
  "approval.approved"
];

export function SqlDetailPage({ id }: { id: string }) {
  const run = reviewQueue[0];

  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <section className="glass-panel rounded-lg p-5 lg:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Code2 className="h-6 w-6 text-[#60a5fa]" />
                <h1 className="text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                  Revenue rollup
                </h1>
                <span className="rounded border border-[#34a853]/25 bg-[#34a853]/10 px-2 py-1 text-[11px] font-semibold text-[#4ade80]">
                  approved
                </span>
              </div>
              <p className="mt-3 font-[var(--font-mono)] text-xs text-slate-600">
                {id} / analytics / current version ver_003
              </p>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                Full lifecycle view for a governed SQL query: current SQL,
                versions, comments, approval history, dry-run cost, policy
                violations, and execution logs.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.06]"
              >
                <GitBranch className="h-4 w-4" />
                Compare version
              </button>
              <button
                type="button"
                className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#4285f4] px-4 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                <ShieldCheck className="h-4 w-4" />
                Request approval
              </button>
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={Code2} title="Current SQL" action="BigQuery Standard SQL" />
              <pre className="sql-code min-h-[420px] overflow-auto bg-[#090c14] p-5 text-slate-200">
                <code>{`SELECT
  DATE_TRUNC(order_date, WEEK) AS week_start,
  acquisition_channel,
  SUM(revenue) AS weekly_revenue,
  COUNT(*) AS order_count
FROM \`analytics.orders\`
WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
  AND status = 'completed'
GROUP BY week_start, acquisition_channel
ORDER BY week_start DESC, weekly_revenue DESC;`}</code>
              </pre>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={MessageSquareText}
                title="Comments"
                action={`${comments.length} notes`}
              />
              <div className="divide-y divide-white/[0.07]">
                {comments.map((comment) => (
                  <div key={`${comment.author}-${comment.createdAt}`} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-100">
                        {comment.author}
                      </p>
                      <span className="text-xs text-slate-600">
                        {comment.createdAt}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      {comment.body}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={FileClock} title="Version history" action="3 versions" />
              <div className="divide-y divide-white/[0.07]">
                {versions.map((version) => (
                  <div key={version.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-[var(--font-mono)] text-xs font-semibold text-[#60a5fa]">
                          {version.id}
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-100">
                          {version.label}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {version.author} / {version.createdAt}
                        </p>
                      </div>
                      <button
                        type="button"
                        title="Restore version"
                        className="focus-ring rounded-md p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={ShieldCheck} title="Approval and cost" action="Passed" />
              <div className="grid grid-cols-3 gap-2 p-4 text-xs">
                <TinyStat label="Cost" value={formatCost(run.estimatedCostUsd)} />
                <TinyStat label="Scan" value={formatBytes(run.scannedBytes)} />
                <TinyStat label="Status" value={run.status.replace("_", " ")} />
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={Clock3} title="Execution log" action="Audit" />
              <div className="space-y-3 p-4">
                {executionLogs.map((log) => (
                  <div
                    key={log}
                    className="rounded-lg border border-white/[0.08] bg-black/[0.16] px-4 py-3 font-[var(--font-mono)] text-xs text-slate-400"
                  >
                    {log}
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  action
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  action: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-[#60a5fa]" />
        <h2 className="text-base font-semibold text-slate-50">{title}</h2>
      </div>
      <span className="text-xs font-semibold text-slate-600">{action}</span>
    </div>
  );
}

function TinyStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 py-2">
      <span className="block text-[11px] font-medium text-slate-600">
        {label}
      </span>
      <span className="mt-1 block font-semibold text-slate-200">{value}</span>
    </span>
  );
}
