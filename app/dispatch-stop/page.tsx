import type { Metadata } from "next";
import { DispatchStopPage } from "@/components/dispatch-stop-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Pre-dispatch stop", description: "Owner-scoped pre-dispatch stop records." };

export default function DispatchStopRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" showDemoBadge={false} /><DispatchStopPage /><SiteFooter />
  </main>;
}
