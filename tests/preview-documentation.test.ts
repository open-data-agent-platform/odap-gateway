import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDryRunTransport, type BigQueryEnv } from "../lib/bigquery";
import { docsFaqs, docsGuides } from "../lib/docs-content";

const readme = readFileSync("README.md", "utf8");
const faq = (question: string) => docsFaqs.find(item => item.question === question)?.answer;

describe("public preview limitations", () => {
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
