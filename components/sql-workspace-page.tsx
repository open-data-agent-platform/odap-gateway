import Link from "next/link";
import {
  CheckCircle2,
  Clock3,
  FileCode2,
  GitBranch,
  ShieldCheck,
  Sparkles,
  Workflow
} from "lucide-react";
import { LiveSqlWorkbench } from "@/components/live-sql-workbench";
import {
  formatBytes,
  formatCost,
  reviewQueue,
  workspaceAllowlist
} from "@/lib/phase2";

const workflowSteps = [
  {
    title: "Draft with schema context",
    body: "Generate BigQuery-first SQL from a business question and active workspace schema.",
    icon: Sparkles
  },
  {
    title: "Dry-run before execution",
    body: "Estimate scanned bytes, runtime, and cost before any live execution path is unlocked.",
    icon: ShieldCheck
  },
  {
    title: "Route risky SQL to review",
    body: "Send high-cost or policy-sensitive queries through the reviewer and approver flow.",
    icon: Workflow
  },
  {
    title: "Save the approved version",
    body: "Keep the SQL, schema context, run result, and audit trail together for the team.",
    icon: GitBranch
  }
];

export function SqlWorkspacePage() {
  const activeReviewCount = reviewQueue.filter(
    (item) => item.status !== "approved"
  ).length;
  const reviewedBytes = reviewQueue.reduce(
    (total, item) => total + item.scannedBytes,
    0
  );
  const reviewedCost = reviewQueue.reduce(
    (total, item) => total + item.estimatedCostUsd,
    0
  );

  return (
    <>
      <section className="border-b border-white/10 bg-[#070a12]">
        <div className="mx-auto grid max-w-[1480px] gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:px-8">
          <div className="min-w-0">
            <h1 className="max-w-4xl text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
              SQL workspace for BigQuery teams.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
              Turn natural language into governed SQL, check BigQuery cost with
              dry-run, and move approved work into an auditable team workflow.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="#workspace"
                className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-[#4285f4] px-4 text-sm font-semibold text-white shadow-[0_0_24px_rgba(66,133,244,0.28)] transition hover:bg-blue-500"
              >
                Open SQL workspace
              </a>
              <Link
                href="/cost"
                className="focus-ring inline-flex h-10 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-semibold text-slate-200 transition hover:border-[#4285f4]/40 hover:bg-white/[0.04]"
              >
                Review cost controls
              </Link>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <SqlMetric
              label="Open reviews"
              value={String(activeReviewCount)}
              detail="Sample review queue"
            />
            <SqlMetric
              label="Dry-run volume"
              value={formatBytes(reviewedBytes)}
              detail="Sample review queue"
            />
            <SqlMetric
              label="Estimated cost"
              value={formatCost(reviewedCost)}
              detail="Sample review queue"
            />
          </div>
        </div>
      </section>

      <section className="border-b border-white/10 bg-[#0a0f1c]/80">
        <div className="mx-auto grid max-w-[1480px] gap-3 px-4 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          {workflowSteps.map((step) => {
            const Icon = step.icon;

            return (
              <article
                key={step.title}
                className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4"
              >
                <Icon className="h-5 w-5 text-[#60a5fa]" />
                <h2 className="mt-3 text-sm font-semibold text-slate-100">
                  {step.title}
                </h2>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {step.body}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section id="workspace">
        <LiveSqlWorkbench compact />
      </section>

      <section className="border-t border-white/10 bg-[#070a12]">
        <div className="mx-auto grid max-w-[1480px] gap-5 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.42fr)] lg:px-8">
          <div className="glass-panel rounded-lg p-5">
            <div className="flex items-center gap-3">
              <FileCode2 className="h-5 w-5 text-[#a855f7]" />
              <h2 className="text-base font-semibold text-slate-50">
                Sample review queue
              </h2>
            </div>
            <div className="mt-5 overflow-hidden rounded-lg border border-white/[0.08]">
              <div className="grid grid-cols-[1fr_130px_120px] border-b border-white/[0.08] bg-white/[0.035] px-4 py-2 text-xs font-semibold text-slate-500">
                <span>Query</span>
                <span>Scan</span>
                <span>Status</span>
              </div>
              {reviewQueue.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[1fr_130px_120px] items-center border-b border-white/[0.06] px-4 py-3 text-sm last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-100">
                      {item.queryType}
                    </span>
                    <span className="mt-1 block text-xs text-slate-600">
                      {item.workspace} / {item.submittedAt}
                    </span>
                  </span>
                  <span className="text-xs font-medium text-slate-400">
                    {formatBytes(item.scannedBytes)}
                  </span>
                  <RunStatus status={item.status} />
                </div>
              ))}
            </div>
          </div>

          <div className="glass-panel rounded-lg p-5">
            <div className="flex items-center gap-3">
              <Clock3 className="h-5 w-5 text-[#fbbc05]" />
              <h2 className="text-base font-semibold text-slate-50">
                Sample workspace access
              </h2>
            </div>
            <div className="mt-5 space-y-3">
              {workspaceAllowlist.map((workspace) => (
                <div
                  key={workspace.workspace}
                  className="rounded-lg border border-white/[0.08] bg-black/[0.16] p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-[var(--font-mono)] text-sm font-semibold text-[#60a5fa]">
                      {workspace.workspace}
                    </p>
                    <span className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-400">
                      {workspace.plan}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#34a853]" />
                    {workspace.owner} / {workspace.runAccess}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function SqlMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
      <p className="text-xs font-semibold uppercase text-slate-600">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-50">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function RunStatus({
  status
}: {
  status: "approved" | "needs_approval" | "blocked";
}) {
  const className = {
    approved: "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]",
    needs_approval: "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]",
    blocked: "border-[#ea4335]/25 bg-[#ea4335]/10 text-[#f87171]"
  }[status];

  return (
    <span
      className={`inline-flex w-fit rounded px-2 py-1 text-[11px] font-semibold ${className}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
