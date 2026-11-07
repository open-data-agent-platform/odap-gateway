import type { Metadata } from "next";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SqlDetailPage } from "@/components/sql-detail-page";

export const metadata: Metadata = {
  title: "SQL Detail",
  description:
    "View SQL lifecycle details, versions, comments, approval history, cost logs, and execution logs.",
  robots: {
    index: true,
    follow: true
  }
};

export function generateStaticParams() {
  return [{ id: "run-1027" }, { id: "run-1026" }, { id: "run-1025" }];
}

export default async function SqlDetailRoute({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="sql" />
      <SqlDetailPage id={id} />
      <SiteFooter />
    </main>
  );
}
