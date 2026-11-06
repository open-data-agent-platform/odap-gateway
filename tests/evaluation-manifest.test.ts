import { describe, expect, it } from "vitest";
import manifest from "../docs/evaluation/scenarios.v1.json";
import numerical from "../docs/evaluation/fixtures/numerical.v1.json";
import ambiguity from "../docs/evaluation/fixtures/ambiguity.v1.json";
import lifecycle from "../docs/evaluation/fixtures/lifecycle.v1.json";
import authorization from "../docs/evaluation/fixtures/authorization.v1.json";
import approvals from "../docs/evaluation/fixtures/approvals.v1.json";
import costs from "../docs/evaluation/fixtures/costs.v1.json";
import recovery from "../docs/evaluation/fixtures/recovery.v1.json";

// This is a check on the evaluation design, not a call to the Gateway.
const quotas = {
  numerical:     { prefix: "NUM", count: 16, outcomes: ["answer"] },
  ambiguity:     { prefix: "AMB", count: 12, outcomes: ["clarify", "abstain", "resolve"] },
  lifecycle:     { prefix: "LIF", count: 14, outcomes: ["allow", "deny", "deduplicate", "preserve"] },
  authorization: { prefix: "AUT", count: 16, outcomes: ["allow", "deny"] },
  approvals:     { prefix: "APR", count: 14, outcomes: ["allow", "deny", "deduplicate", "preserve"] },
  costs:         { prefix: "CST", count: 14, outcomes: ["allow", "deny", "settle", "hold", "bounded", "overrun", "deduplicate"] },
  recovery:      { prefix: "REC", count: 14, outcomes: ["observe", "pending", "preserve", "verify", "deny", "enrich", "rollback", "deduplicate"] }
};

describe("local scenario manifest (structure only)", () => {
  it("has one local input for each case in its declared category", () => {
    const inputs = { numerical, ambiguity, lifecycle, authorization: authorization.cases,
      approvals: approvals.cases, costs: costs.cases, recovery: recovery.cases };
    for (const [category, fixtures] of Object.entries(inputs)) {
      const group = manifest.categories.find(g => g.category === category)!;
      expect(Object.keys(fixtures).sort(), category).toEqual(group.cases.map(c => c.id).sort());
    }
  });

  it("allocates 100 distinct, unscored cases across the seven planned categories", () => {
    expect(Object.keys(manifest).sort()).toEqual(["categories", "exclusions", "status", "total", "version"]);
    expect(manifest).toMatchObject({ version: 1, status: "local-design-only", total: 100 });
    expect(manifest.exclusions.length).toBeGreaterThan(0);
    expect(manifest.exclusions.every(line => line.trim().length > 0)).toBe(true);
    expect(manifest.categories.map(g => g.category).sort()).toEqual(Object.keys(quotas).sort());
    const cases = manifest.categories.flatMap<{ id: string; given: string }>(g => g.cases);
    expect(cases).toHaveLength(manifest.total);
    expect(new Set(cases.map(c => c.id)).size).toBe(manifest.total);
    expect(new Set(cases.map(c => c.given.trim().toLowerCase().replace(/\s+/g, " "))).size).toBe(manifest.total);
  });

  it.each(Object.entries(quotas))("checks the %s quota, IDs and expected outcomes", (name, quota) => {
    const group = manifest.categories.find(g => g.category === name)!;
    expect(group.planned).toBe(quota.count);
    expect(group.cases).toHaveLength(quota.count);
    expect(new Set(group.cases.map(c => c.expected.outcome))).toEqual(new Set(quota.outcomes));
    for (const [i, c] of group.cases.entries()) {
      expect(c.id).toBe(quota.prefix + "-" + String(i + 1).padStart(2, "0"));
      expect(Object.keys(c).sort(), c.id).toEqual(["expected", "given", "id"]);
      expect(c.given.trim(), c.id).not.toBe("");
      const oracle = c.expected;
      if (name === "numerical") {
        expect(Object.keys(oracle).sort(), c.id).toEqual(["outcome", "unit", "value"]);
        expect("value" in oracle && (oracle.value === null || Number.isSafeInteger(oracle.value)), c.id).toBe(true);
        expect("unit" in oracle && !!oracle.unit.trim(), c.id).toBe(true);
      } else {
        expect(Object.keys(oracle).sort(), c.id).toEqual(["assertion", "outcome"]);
        expect("assertion" in oracle && !!oracle.assertion.trim(), c.id).toBe(true);
      }
    }
  });
});
