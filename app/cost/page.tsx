import type { Metadata } from "next";
import { CostControlPage } from "@/components/cost-control-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Budget Accounting",
  description:
    "Owner-scoped reconciliation of recorded SQL, model and tool costs, pending reserves, and budget ledger differences.",
  robots: {
    index: true,
    follow: true
  }
};

export default function CostPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="cost" showDemoBadge={false} />
      <CostControlPage />
      <SiteFooter />
    </main>
  );
}
