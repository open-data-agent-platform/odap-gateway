import type { Metadata } from "next";
import { CostControlPage } from "@/components/cost-control-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Cost Control",
  description:
    "Dry-run cost estimates, team budgets, risk routing, and SQL audit logs for Open Data Agent Platform.",
  robots: {
    index: false,
    follow: false
  }
};

export default function CostPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="cost" />
      <CostControlPage />
      <SiteFooter />
    </main>
  );
}
