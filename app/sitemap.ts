import type { MetadataRoute } from "next";
import { gatewayPath } from "../lib/gateway-path";

export const dynamic = "force-static";

const routes = ["/", "/sql", "/schemas", "/approvals", "/cost", "/team/policies", "/docs"];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: (process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? "https://example.com") + gatewayPath(route),
    lastModified: new Date("2026-07-01")
  }));
}
