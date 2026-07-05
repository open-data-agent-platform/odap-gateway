import type { Metadata } from "next";
import { LoginPanel } from "@/components/login-panel";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Open Data Agent Platform with Google or GitHub.",
  robots: {
    index: false,
    follow: false
  }
};

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-[#070a12] text-slate-100">
      <SiteHeader />
      <LoginPanel />
      <SiteFooter />
    </main>
  );
}
