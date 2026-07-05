import type { Metadata } from "next";
import { SchemasPage } from "@/components/schemas-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Schemas",
  description:
    "Browse BigQuery projects, datasets, tables, columns, PII tags, and sample SQL queries.",
  robots: {
    index: false,
    follow: false
  }
};

export default function SchemasRoute() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="schemas" />
      <SchemasPage />
      <SiteFooter />
    </main>
  );
}
