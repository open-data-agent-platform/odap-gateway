import type { Metadata } from "next";
import { BigQueryOnboardingPage } from "@/components/bigquery-onboarding-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Connect BigQuery",
  description:
    "Connect a BigQuery project, test credentials, and start schema sync for Open Data Agent Platform.",
  robots: {
    index: false,
    follow: false
  }
};

export default function BigQueryOnboardingRoute() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="schemas" />
      <BigQueryOnboardingPage />
      <SiteFooter />
    </main>
  );
}
