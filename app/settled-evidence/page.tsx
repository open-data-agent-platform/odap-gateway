import type { Metadata } from "next";
import { SettledEvidencePage } from "@/components/settled-evidence-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Settled evidence",
  description: "Owner-scoped inspection and download of stored settled evidence." };

export default function SettledRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" showDemoBadge={false} /><SettledEvidencePage /><SiteFooter />
  </main>;
}
