import type { MetadataRoute } from "next";
import { privateRobotsPaths, siteUrl } from "@/lib/seo";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: privateRobotsPaths
      }
    ],
    sitemap: `${siteUrl}/sitemap.xml`
  };
}
