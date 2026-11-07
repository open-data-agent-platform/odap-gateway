import type { Metadata } from "next";
import { ApprovalsPage } from "@/components/approvals-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Approvals",
  description:
    "Review high-risk SQL, dry-run costs, policy violations, and approval decisions.",
  robots: {
    index: true,
    follow: true
  }
};

export default function ApprovalsRoute() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader active="approvals" />
      <ApprovalsPage />
      <SiteFooter />
    </main>
  );
}
