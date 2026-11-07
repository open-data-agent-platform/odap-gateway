import type { Metadata } from "next";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { TeamPoliciesPage } from "@/components/team-policies-page";

export const metadata: Metadata = {
  title: "Team Policies",
  description:
    "Configure Open Data Agent Platform governance policies for SELECT *, LIMIT, PII fields, schema access, and dry-run execution gates.",
  robots: {
    index: true,
    follow: true
  }
};

export default function PoliciesPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="policies" />
      <TeamPoliciesPage />
      <SiteFooter />
    </main>
  );
}
