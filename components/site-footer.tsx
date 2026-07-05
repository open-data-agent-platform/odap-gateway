import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#070a12]">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-slate-500 sm:px-6 lg:px-8">
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-slate-400" aria-label="Footer">
          <Link href="/sql" className="transition hover:text-slate-200">
            SQL Workspace
          </Link>
          <Link href="/schemas" className="transition hover:text-slate-200">
            Schemas
          </Link>
          <Link href="/approvals" className="transition hover:text-slate-200">
            Approvals
          </Link>
          <Link href="/cost" className="transition hover:text-slate-200">
            Cost Controls
          </Link>
        </nav>
        <p>
          Open Data Agent Platform is an independent product for governed
          natural-language access to open and warehouse data.
        </p>
        <p>
          Admin release controls, dry-run gates, schema governance, and audit
          trails are staged through the Worker deployment. Live database
          execution remains governed by BigQuery dry-run safety controls.
        </p>
      </div>
    </footer>
  );
}
