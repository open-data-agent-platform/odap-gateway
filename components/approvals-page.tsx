import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileDiff,
  MessageSquareText,
  ShieldCheck,
  XCircle
} from "lucide-react";
import {
  formatBytes,
  formatCost,
  reviewQueue,
  type QueryRunStatus
} from "@/lib/phase2";

const selectedApproval = reviewQueue.find(
  (item) => item.status === "needs_approval"
) ?? reviewQueue[0];

const violationList = [
  "Cost exceeds approval threshold",
  "Missing partition filter on event_date",
  "Touches PII-adjacent customer identifier"
];

export function ApprovalsPage() {
  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto grid max-w-[1480px] gap-5 px-4 sm:px-6 lg:grid-cols-[380px_minmax(0,1fr)] lg:px-8">
        <aside className="glass-panel overflow-hidden rounded-lg">
          <div className="border-b border-white/[0.08] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-[#60a5fa]" />
                <h1 className="text-base font-semibold text-slate-50">
                  Approvals
                </h1>
              </div>
              <span className="rounded border border-[#fbbc05]/25 bg-[#fbbc05]/10 px-2 py-1 text-[11px] font-semibold text-[#facc15]">
                {reviewQueue.filter((item) => item.status !== "approved").length} open
              </span>
            </div>
          </div>
          <div className="divide-y divide-white/[0.07]">
            {reviewQueue.map((item) => (
              <button
                key={item.id}
                type="button"
                className="focus-ring block w-full px-5 py-4 text-left transition hover:bg-white/[0.04]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {item.queryType}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {item.workspace} / {item.submittedAt}
                    </p>
                  </div>
                  <StatusPill status={item.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <TinyStat label="Cost" value={formatCost(item.estimatedCostUsd)} />
                  <TinyStat label="Scan" value={formatBytes(item.scannedBytes)} />
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 space-y-5">
          <section className="glass-panel rounded-lg p-5 lg:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                    {selectedApproval.queryType}
                  </h2>
                  <StatusPill status={selectedApproval.status} />
                </div>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                  Review the SQL diff, dry-run result, triggered policy rules,
                  and request context before approving execution.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <DecisionButton tone="approve" icon={CheckCircle2} label="Approve" />
                <DecisionButton tone="reject" icon={XCircle} label="Reject" />
                <DecisionButton
                  tone="neutral"
                  icon={MessageSquareText}
                  label="Request changes"
                />
              </div>
            </div>
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={FileDiff} title="SQL diff" action="Latest version" />
              <pre className="sql-code min-h-[360px] overflow-auto bg-[#090c14] p-5 text-slate-200">
                <code>{`-- requested by editor@acme.test
SELECT
  campaign_id,
  session_id,
  user_id,
  COUNT(*) AS sessions
FROM \`marketing.sessions\`
WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
GROUP BY campaign_id, session_id, user_id
ORDER BY sessions DESC;`}</code>
              </pre>
            </section>

            <aside className="space-y-5">
              <section className="glass-panel overflow-hidden rounded-lg">
                <SectionTitle
                  icon={AlertTriangle}
                  title="Triggered rules"
                  action="High risk"
                />
                <div className="space-y-3 p-4">
                  {violationList.map((violation) => (
                    <div
                      key={violation}
                      className="rounded-lg border border-[#fbbc05]/20 bg-[#fbbc05]/[0.08] p-4"
                    >
                      <div className="flex gap-3">
                        <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-[#facc15]" />
                        <p className="text-sm leading-6 text-slate-300">
                          {violation}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="glass-panel overflow-hidden rounded-lg">
                <SectionTitle icon={Clock3} title="Dry-run result" action="Fresh" />
                <div className="grid grid-cols-3 gap-2 p-4 text-xs">
                  <TinyStat
                    label="Cost"
                    value={formatCost(selectedApproval.estimatedCostUsd)}
                  />
                  <TinyStat
                    label="Scan"
                    value={formatBytes(selectedApproval.scannedBytes)}
                  />
                  <TinyStat label="Risk" value="High" />
                </div>
                <p className="border-t border-white/[0.08] px-5 py-4 text-sm leading-6 text-slate-500">
                  Approval is required because this run touches user-level data
                  and exceeds the configured per-query review threshold.
                </p>
              </section>
            </aside>
          </div>
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

function DecisionButton({
  icon: Icon,
  label,
  tone
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: "approve" | "reject" | "neutral";
}) {
  const className = {
    approve: "bg-[#34a853] text-white hover:bg-[#3fc365]",
    reject: "border border-[#ea4335]/30 text-[#f87171] hover:bg-[#ea4335]/10",
    neutral: "border border-white/10 text-slate-200 hover:bg-white/[0.06]"
  }[tone];

  return (
    <button
      type="button"
      className={`focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition ${className}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
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

function StatusPill({ status }: { status: QueryRunStatus }) {
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
