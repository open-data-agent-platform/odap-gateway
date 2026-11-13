import type { Metadata } from "next";
import { CancellationEvidencePage } from "@/components/cancellation-evidence-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Cancellation request evidence",
  description: "Owner-scoped inspection and download of recorded cancellation requests, not cancellation confirmation." };

export default function CancellationEvidenceRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" showDemoBadge={false} /><CancellationEvidencePage /><SiteFooter />
  </main>;
}
