import {
  AlertTriangle,
  BarChart3,
  Gauge,
  ListChecks,
  ShieldCheck,
  TrendingUp,
  WalletCards
} from "lucide-react";
import {
  formatBytes,
  formatCost,
  reviewQueue,
  workspaceAllowlist
} from "@/lib/phase2";

const monthlyBudgetUsd = 1200;
const usedBudgetUsd = 326.44;
const forecastBudgetUsd = 784.2;

const costLeaders = [
  {
    name: "Mira Chen",
    role: "Analytics lead",
    dryRuns: 184,
    cost: 112.4,
    bytes: 24.6 * 1024 ** 3
  },
  {
    name: "Devon Patel",
    role: "Growth analyst",
    dryRuns: 96,
    cost: 78.1,
    bytes: 17.2 * 1024 ** 3
  },
  {
    name: "Riley Jones",
    role: "Data engineer",
    dryRuns: 73,
    cost: 51.7,
    bytes: 11.4 * 1024 ** 3
  }
];

const budgetRules = [
  {
    title: "Auto block high-cost scans",
    detail: "Queries above team threshold move to approval instead of execution.",
    state: "Enabled"
  },
  {
    title: "Require partition filters",
    detail: "Date-partitioned tables must include WHERE bounds before dry-run passes.",
    state: "Enabled"
  },
  {
    title: "Audit every SQL run",
    detail: "Each dry-run stores scanned bytes, estimated USD, risk level, and actor.",
    state: "Enabled"
  }
];

export function CostControlPage() {
  const usedPercent = Math.round((usedBudgetUsd / monthlyBudgetUsd) * 100);
  const forecastPercent = Math.round(
    (forecastBudgetUsd / monthlyBudgetUsd) * 100
  );
  const scannedBytes = reviewQueue.reduce(
    (total, item) => total + item.scannedBytes,
    0
  );
  const activeRiskCount = reviewQueue.filter(
    (item) => item.status !== "approved"
  ).length;

  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-6">
                <div>
                  <h1 className="text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                    Cost control for BigQuery SQL.
                  </h1>
                  <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                    Track dry-run estimates, route risky queries to approval,
                    and keep team budget decisions tied to the SQL audit trail.
                  </p>
                </div>
                <div className="rounded-lg border border-[#4285f4]/20 bg-[#4285f4]/10 p-4">
                  <div className="flex items-center gap-3">
                    <WalletCards className="h-5 w-5 text-[#60a5fa]" />
                    <p className="text-sm font-semibold text-slate-100">
                      Monthly team budget
                    </p>
                  </div>
                  <p className="mt-4 text-3xl font-semibold text-slate-50">
                    {formatCost(usedBudgetUsd)}
                    <span className="text-base font-medium text-slate-500">
                      {" "}
                      / {formatCost(monthlyBudgetUsd)}
                    </span>
                  </p>
                  <BudgetBar value={usedPercent} />
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    Forecast: {formatCost(forecastBudgetUsd)} this month, or{" "}
                    {forecastPercent}% of budget.
                  </p>
                </div>
              </div>
            </section>

            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <CostMetric
                icon={Gauge}
                label="Dry-run scan"
                value={formatBytes(scannedBytes)}
                detail="From active review queue"
              />
              <CostMetric
                icon={ShieldCheck}
                label="Risk reviews"
                value={String(activeRiskCount)}
                detail="Need reviewer action"
              />
              <CostMetric
                icon={BarChart3}
                label="Budget used"
                value={`${usedPercent}%`}
                detail="Team monthly cap"
              />
              <CostMetric
                icon={TrendingUp}
                label="Forecast"
                value={formatCost(forecastBudgetUsd)}
                detail="Based on current run rate"
              />
            </div>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={ListChecks}
                title="Cost audit log"
                action={`${reviewQueue.length} dry-runs`}
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead className="border-b border-white/[0.08] bg-white/[0.035] text-left text-xs font-semibold text-slate-500">
                    <tr>
                      <th className="px-5 py-3">SQL</th>
                      <th className="px-5 py-3">Workspace</th>
                      <th className="px-5 py-3">Bytes</th>
                      <th className="px-5 py-3">Cost</th>
                      <th className="px-5 py-3">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {reviewQueue.map((item) => (
                      <tr key={item.id}>
                        <td className="px-5 py-4">
                          <span className="block font-semibold text-slate-100">
                            {item.queryType}
                          </span>
                          <span className="mt-1 block font-[var(--font-mono)] text-xs text-slate-600">
                            {item.id}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-slate-400">
                          {item.workspace}
                        </td>
                        <td className="px-5 py-4 text-slate-400">
                          {formatBytes(item.scannedBytes)}
                        </td>
                        <td className="px-5 py-4 font-semibold text-slate-200">
                          {formatCost(item.estimatedCostUsd)}
                        </td>
                        <td className="px-5 py-4">
                          <RiskPill status={item.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={BarChart3}
                title="User cost ranking"
                action="Current month"
              />
              <div className="grid gap-px bg-white/[0.07] sm:grid-cols-3">
                {costLeaders.map((user) => (
                  <article key={user.name} className="bg-[#0a0f1c] p-5">
                    <p className="text-sm font-semibold text-slate-100">
                      {user.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{user.role}</p>
                    <div className="mt-5 grid grid-cols-3 gap-2 text-xs">
                      <TinyStat label="Cost" value={formatCost(user.cost)} />
                      <TinyStat label="Runs" value={String(user.dryRuns)} />
                      <TinyStat label="Scan" value={formatBytes(user.bytes)} />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={AlertTriangle}
                title="Budget policies"
                action="Guarded"
              />
              <div className="space-y-3 p-4">
                {budgetRules.map((rule) => (
                  <div
                    key={rule.title}
                    className="rounded-lg border border-white/[0.08] bg-black/[0.16] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-100">
                        {rule.title}
                      </p>
                      <span className="rounded border border-[#34a853]/25 bg-[#34a853]/10 px-2 py-1 text-[11px] font-semibold text-[#4ade80]">
                        {rule.state}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {rule.detail}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={ShieldCheck}
                title="Workspace gates"
                action={`${workspaceAllowlist.length} teams`}
              />
              <div className="divide-y divide-white/[0.07]">
                {workspaceAllowlist.map((workspace) => (
                  <div key={workspace.workspace} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-[var(--font-mono)] text-sm font-semibold text-[#60a5fa]">
                        {workspace.workspace}
                      </p>
                      <RiskPill status={workspace.runAccess} />
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {workspace.owner} / {workspace.plan}
                    </p>
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

function CostMetric({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="glass-panel rounded-lg p-5">
      <Icon className="h-5 w-5 text-[#60a5fa]" />
      <p className="mt-4 text-xs font-semibold uppercase text-slate-600">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-slate-50">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
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

function BudgetBar({ value }: { value: number }) {
  return (
    <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/30">
      <div
        className="h-full rounded-full bg-[linear-gradient(90deg,#34a853,#fbbc05)]"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function RiskPill({
  status
}: {
  status:
    | "approved"
    | "needs_approval"
    | "blocked"
    | "allowlisted"
    | "review";
}) {
  const className = {
    approved: "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]",
    allowlisted: "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]",
    needs_approval: "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]",
    review: "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]",
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
