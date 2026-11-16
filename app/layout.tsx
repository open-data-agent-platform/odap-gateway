import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? "https://example.com"),
  title: {
    default: "ODAP Gateway - Governed Data Access for AI Agents",
    template: "%s | ODAP Gateway"
  },
  description:
    "ODAP Gateway preview: BigQuery workflows and a bounded PostgreSQL Node host with semantic releases, approval contracts and audit evidence. Not a production-readiness claim.",
  robots: {
    index: true,
    follow: true
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
