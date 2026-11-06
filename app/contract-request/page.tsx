import type { Metadata } from "next";
import { ContractRequestHistory } from "@/components/contract-request-history";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = { title: "My contract request" };

export default function ContractRequestRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader active="approvals" /><ContractRequestHistory /><SiteFooter />
  </main>;
}
