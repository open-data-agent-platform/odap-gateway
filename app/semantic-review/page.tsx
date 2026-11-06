import type { Metadata } from "next";
import { SemanticReviewPage } from "@/components/semantic-review-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Semantic review" };

export default function SemanticReviewRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader /><SemanticReviewPage /><SiteFooter />
  </main>;
}
