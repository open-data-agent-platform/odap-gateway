import type { Metadata } from "next";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SqlWorkspacePage } from "@/components/sql-workspace-page";

export const metadata: Metadata = {
  title: "SQL Workspace",
  description:
    "Generate, dry-run, review, and version SQL in one governed team workspace."
};

export default function SqlPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="sql" />
      <SqlWorkspacePage />
      <SiteFooter />
    </main>
  );
}
