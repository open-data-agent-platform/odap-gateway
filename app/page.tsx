import Link from "next/link";
import { ArrowRight, DatabaseZap, GitBranch, ShieldCheck, WalletCards } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const modules = [
  {
    href: "/sql",
    title: "Governed SQL workspace",
    body: "Generate BigQuery SQL, dry-run it, and move risky work into review.",
    icon: DatabaseZap
  },
  {
    href: "/schemas",
    title: "Schema and policy catalog",
    body: "Import metadata, mark PII fields, and keep queryable fields explicit.",
    icon: GitBranch
  },
  {
    href: "/approvals",
    title: "Approval flow",
    body: "Review high-risk SQL before execution with cost and policy context.",
    icon: ShieldCheck
  },
  {
    href: "/cost",
    title: "Cost controls",
    body: "Track bytes scanned, estimated spend, and budget guardrails.",
    icon: WalletCards
  }
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="sql" />
      <section className="border-b border-white/10 bg-[linear-gradient(180deg,#070a12,#0b1224)]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.55fr)] lg:items-center lg:px-8 lg:py-20">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-[#60a5fa]">
              ODAP Gateway
            </p>
            <h1 className="mt-5 max-w-4xl text-4xl font-semibold tracking-normal text-slate-50 sm:text-6xl">
              Governed BigQuery access for AI agents.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-slate-400">
              A local reference implementation of the ODAP Five Musts: open,
              semantic, governed, auditable, and cost-controlled.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/sql"
                className="inline-flex h-11 items-center gap-2 rounded-md bg-[#4285f4] px-5 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Open workspace <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/schemas"
                className="inline-flex h-11 items-center rounded-md border border-white/10 px-5 text-sm font-semibold text-slate-200 transition hover:border-white/30"
              >
                Review schemas
              </Link>
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-5">
            <pre className="sql-code overflow-auto rounded-md bg-black/30 p-4 text-sm text-slate-200">
              <code>{`-- Demo data only
SELECT
  DATE_TRUNC(order_date, WEEK) AS week_start,
  acquisition_channel,
  SUM(revenue) AS weekly_revenue
FROM \`demo.orders\`
WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
GROUP BY week_start, acquisition_channel;`}</code>
            </pre>
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-7xl gap-4 px-4 py-12 sm:px-6 md:grid-cols-2 lg:px-8">
        {modules.map((module) => {
          const Icon = module.icon;
          return (
            <Link
              key={module.href}
              href={module.href}
              className="rounded-lg border border-white/10 bg-white/[0.035] p-5 transition hover:border-[#60a5fa]/50"
            >
              <Icon className="h-6 w-6 text-[#60a5fa]" />
              <h2 className="mt-4 text-lg font-semibold text-slate-50">
                {module.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                {module.body}
              </p>
            </Link>
          );
        })}
      </section>
      <SiteFooter />
    </main>
  );
}
