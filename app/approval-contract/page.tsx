import type { Metadata } from "next";
import { ApprovalContractPage } from "@/components/approval-contract-page";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = { title: "Approval contract" };

export default function ApprovalContractRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" /><ApprovalContractPage /><SiteFooter />
  </main>;
}
