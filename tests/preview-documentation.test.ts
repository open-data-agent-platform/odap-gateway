import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDryRunTransport, type BigQueryEnv } from "../lib/bigquery";
import { docsFaqs, docsGuides } from "../lib/docs-content";
import { GATEWAY_VERSION, GATEWAY_RELEASE_URL, POSTGRESQL_GUIDE_URL,
  POSTGRESQL_PREVIEW_SUMMARY, POSTGRESQL_PREVIEW_BOUNDARY } from "../lib/gateway-release";

const readme = readFileSync("README.md", "utf8");
const faq = (question: string) => docsFaqs.find(item => item.question === question)?.answer;

describe("public preview limitations", () => {
  it("keeps the package, lockfile and public release links on the same preview", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    expect(GATEWAY_VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(GATEWAY_RELEASE_URL).toBe(`https://github.com/open-data-agent-platform/odap-gateway/releases/tag/v${pkg.version}`);
    expect(POSTGRESQL_GUIDE_URL).toContain(`/blob/v${pkg.version}/docs/POSTGRESQL_CONNECTOR.md`);
  });

  it("distinguishes the PostgreSQL Node host from the hosted site", () => {
    expect(POSTGRESQL_PREVIEW_SUMMARY).toContain("Separate Node host");
    expect(POSTGRESQL_PREVIEW_SUMMARY).toContain("single-table COUNT/SUM");
    expect(faq("Can I query PostgreSQL from this website?")).toContain(POSTGRESQL_PREVIEW_BOUNDARY);
    const guide = docsGuides.find(item => item.id === "postgresql-preview");
    expect(guide?.steps.join(" ")).toContain("cost remains unpriced");
    expect(guide?.steps).toContain(POSTGRESQL_PREVIEW_BOUNDARY);
    expect(readFileSync("app/page.tsx", "utf8")).toContain("{POSTGRESQL_PREVIEW_BOUNDARY}");
  });

  it("keeps production and independent acceptance limits in the numbered release", () => {
    const notes = readFileSync("docs/RELEASE_0_3_0_PREVIEW_1.md", "utf8");
    expect(notes).toContain(GATEWAY_VERSION);
    for (const text of ["15.20", "16.16", "17.12", "18.7", "unpriced", "observation-required", "independent review", "not a completed Gateway acceptance"])
      expect(notes).toContain(text);
  });
  it("identifies the package version without claiming formal acceptance", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(readme).toContain(`**Preview ${version}`);
    expect(readme).toContain("not a completed Gateway acceptance");
    expect(readme).not.toContain("Early-stage reference implementation (v0.1.x)");
    expect(readme).not.toContain("Every query is schema-grounded");
  });

  it.each([
    { GATEWAY_MODE: "production" },
    { GATEWAY_MODE: "production", BIGQUERY_DRY_RUN_MODE: "simulated" },
    { GATEWAY_MODE: "production", BIGQUERY_DRY_RUN_MODE: "live", BIGQUERY_PROJECT_ID: "fixture",
      BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "synthetic-not-a-key" }
  ] satisfies BigQueryEnv[])("matches the production raw-preview refusal: %j", env => {
    expect(resolveDryRunTransport(env).mode).toBe("blocked");
    const answer = faq("Can the site execute live BigQuery jobs?");
    expect(answer).toContain("raw SQL dry-runs are disabled in production");
    expect(answer).toContain("Adding service-account credentials does not enable them");
    expect(answer).toContain("Do not switch a production deployment to demo mode");
  });

  it("distinguishes structured compilation from warehouse execution and cost", () => {
    const answer = faq("What does a structured metric preview confirm?");
    expect(answer).toContain("Semantic Release");
    expect(answer).toContain("does not contact BigQuery");
    expect(answer).toContain("does not estimate warehouse cost");
    expect(answer).toContain("does not authorize execution");
  });

  it("does not equate legacy review with an execution contract", () => {
    const guide = docsGuides.find(item => item.id === "dry-run-review");
    expect(guide?.steps.join(" ")).toContain("does not issue an Approval Contract");
    expect(guide?.steps.join(" ")).toContain("does not dispatch a BigQuery job");
    expect(guide?.summary).toContain("isolated demo");
  });

  it("labels local drafting and its sample schema instead of promising general generation", () => {
    const guide = docsGuides.find(item => item.id === "first-query");
    expect(guide?.summary).toContain("rule-based");
    expect(guide?.summary).toContain("sample schema");
    expect(guide?.steps.join(" ")).toContain("not an execution approval");
  });

  it("does not advertise governed warehouse dry-runs in page metadata", () => {
    const source = readFileSync("app/docs/page.tsx", "utf8");
    expect(source).toContain("preview limitations");
    expect(source).not.toContain("SQL generation and governed dry-runs");
  });
});
