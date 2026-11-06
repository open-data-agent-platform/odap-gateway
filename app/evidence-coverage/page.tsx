import type { Metadata } from "next";
import { EvidenceCoveragePage } from "@/components/evidence-coverage-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Evidence coverage" };

export default function CoverageRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader /><EvidenceCoveragePage /><SiteFooter />
  </main>;
}
