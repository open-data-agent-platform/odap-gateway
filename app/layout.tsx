import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://example.com"),
  title: {
    default: "ODAP Gateway - Governed BigQuery Access for AI Agents",
    template: "%s | ODAP Gateway"
  },
  description:
    "A local reference implementation of the Open Data Agent Platform Five Musts for governed BigQuery dry-runs, approvals, audit trails, and schema policy.",
  robots: {
    index: false,
    follow: false
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
