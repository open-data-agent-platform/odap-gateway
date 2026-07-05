export const siteUrl = "https://odap-gateway.example";

export type PublicRoute = {
  path: string;
  lastModified: string;
  changeFrequency:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority: number;
};

export const publicRoutes: PublicRoute[] = [
  {
    path: "",
    lastModified: "2026-07-05",
    changeFrequency: "weekly",
    priority: 1
  },
  {
    path: "/sql",
    lastModified: "2026-07-02",
    changeFrequency: "weekly",
    priority: 0.95
  }
];

export const privateRobotsPaths = [
  "/admin",
  "/login",
  "/approvals",
  "/cost",
  "/onboarding/",
  "/schemas",
  "/sql/",
  "/api/",
  "/api/auth/",
  "/_next/"
];
