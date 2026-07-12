import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const routes = ["/", "/sql", "/schemas", "/approvals", "/cost", "/team/policies", "/docs"];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `https://example.com${route}`,
    lastModified: new Date("2026-07-01")
  }));
}
