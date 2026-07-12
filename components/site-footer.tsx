import Link from "next/link";
import { OPEN_SOURCE_DISCLAIMER, SOURCE_REPOSITORY_URL } from "@/lib/open-source";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#070a12]">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-slate-500 sm:px-6 lg:px-8">
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-slate-400" aria-label="Footer">
          <Link href="/docs" className="transition hover:text-slate-200">
            Docs
          </Link>
          <Link href="/sql" className="transition hover:text-slate-200">
            SQL Workspace
          </Link>
          <a
            href={SOURCE_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-slate-200"
          >
            Source Code
          </a>
          <a
            href="https://googlesql.com/odap/manifesto"
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-slate-200"
          >
            ODAP Manifesto
          </a>
        </nav>
        <p>ODAP Gateway is a reference implementation for governed AI-to-data workflows.</p>
        <p>{OPEN_SOURCE_DISCLAIMER}</p>
      </div>
    </footer>
  );
}
