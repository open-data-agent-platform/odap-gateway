import type { Metadata } from "next";
import { LiveSqlWorkbench } from "@/components/live-sql-workbench";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SOURCE_REPOSITORY_URL } from "@/lib/open-source";

export const metadata: Metadata = {
  title: "Open Data Agent Platform Tools",
  description:
    "Free Open Data Agent Platform tools for text to SQL, SQL explain, and query optimization."
};

export default function ToolsPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="sql" />
      <section className="border-b border-white/10 bg-[#111a2e]">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 text-sm leading-6 text-slate-300 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <p>
            Use the hosted ODAP tools here,{" "}
            <a
              href={SOURCE_REPOSITORY_URL}
              className="font-semibold text-[#8bd3ff] transition hover:text-[#a6ffcb]"
              target="_blank"
              rel="noreferrer"
            >
              or self-host from source
            </a>
            .
          </p>
        </div>
      </section>
      <LiveSqlWorkbench compact />
      <SiteFooter />
    </main>
  );
}
