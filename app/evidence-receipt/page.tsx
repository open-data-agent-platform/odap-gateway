import type { Metadata } from "next";
import { EvidenceReceiptPage } from "@/components/evidence-receipt-page";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Evidence receipt" };

export default function ReceiptRoute() {
  return <main className="min-h-screen bg-[#070a12] text-slate-100">
    <SiteHeader /><EvidenceReceiptPage /><SiteFooter />
  </main>;
}
