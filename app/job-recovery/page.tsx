import type { Metadata } from "next";
import { JobRecoveryPage } from "@/components/job-recovery-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Job recovery",
  description: "Owner-scoped inspection of stored delegated job identity and terminal observations." };

export default function RecoveryRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" showDemoBadge={false} /><JobRecoveryPage /><SiteFooter />
  </main>;
}
