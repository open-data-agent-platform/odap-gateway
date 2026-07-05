import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://odap-gateway.example"),
  title: {
    default: "ODAP Gateway - Governed Agent Data Access",
    template: "%s | ODAP Gateway"
  },
  description:
    "Reference implementation of a governed gateway for AI agents querying enterprise data with schema policy, audit, approvals, and dry-run cost controls.",
  openGraph: {
    title: "ODAP Gateway",
    description:
      "Reference implementation of the ODAP Five Musts for governed agent data access.",
    url: "https://odap-gateway.example",
    siteName: "ODAP Gateway",
    type: "website"
  },
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
