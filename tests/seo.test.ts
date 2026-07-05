import { describe, expect, it } from "vitest";
import { privateRobotsPaths, publicRoutes, siteUrl } from "../lib/seo";

describe("seo config", () => {
  it("keeps private and auth routes out of the public sitemap", () => {
    const sitemapPaths = publicRoutes.map((route) => route.path);

    expect(sitemapPaths).not.toContain("/admin");
    expect(sitemapPaths).not.toContain("/login");
    expect(sitemapPaths).not.toContain("/approvals");
    expect(sitemapPaths).not.toContain("/cost");
    expect(sitemapPaths).not.toContain("/schemas");
    expect(sitemapPaths.some((path) => path.startsWith("/api"))).toBe(false);
  });

  it("publishes the primary SQL product route", () => {
    const sitemapPaths = publicRoutes.map((route) => route.path);

    expect(sitemapPaths).toEqual(expect.arrayContaining(["/sql"]));
  });

  it("blocks admin, login, and API routes in robots", () => {
    expect(privateRobotsPaths).toEqual(
      expect.arrayContaining([
        "/admin",
        "/login",
        "/approvals",
        "/cost",
        "/onboarding/",
        "/schemas",
        "/sql/",
        "/api/",
        "/api/auth/"
      ])
    );
  });

  it("uses the production canonical origin", () => {
    expect(siteUrl).toBe("https://odap-gateway.example");
  });
});
