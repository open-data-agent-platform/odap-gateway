import { describe, expect, it } from "vitest";
import fixtures from "../docs/evaluation/fixtures/ambiguity.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

type Input = {
  question: string;
  metrics: { ref: string; state: string; terms: string[]; unit: string; dimensions: Record<string, string> }[];
  dimensions: Record<string, { terms: string[]; values: string[] }>;
  session: Record<string, string>;
};

function distinctText(values: string[]) {
  expect(values.length).toBeGreaterThan(0);
  expect(values.every(v => v.trim().length > 0)).toBe(true);
  expect(new Set(values.map(v => v.trim().toLowerCase())).size).toBe(values.length);
}

describe("ambiguity fixture inputs (no model or adapter)", () => {
  const inputs: Record<string, Input> = fixtures;
  it("covers only the declared ambiguity cases, with one distinct question per case", () => {
    const declared = manifest.categories.find(g => g.category === "ambiguity")!.cases;
    expect(Object.keys(inputs).sort()).toEqual(declared.map(c => c.id).sort());
    distinctText(Object.values(inputs).map(c => c.question));
  });

  it.each(Object.keys(fixtures))("%s contains only input fields with valid local references", id => {
    const input = inputs[id];
    expect(Object.keys(input).sort()).toEqual(["dimensions", "metrics", "question", "session"]);
    distinctText(input.metrics.map(m => m.ref));
    const used = new Set<string>();
    for (const metric of input.metrics) {
      expect(Object.keys(metric).sort()).toEqual(["dimensions", "ref", "state", "terms", "unit"]);
      expect(metric.ref).toMatch(/^[a-z][a-z_0-9]*@[1-9][0-9]*$/);
      expect(["released", "candidate"]).toContain(metric.state);
      expect(metric.unit.trim()).not.toBe("");
      distinctText(metric.terms);
      for (const [key, requirement] of Object.entries(metric.dimensions)) {
        expect(["required", "optional"]).toContain(requirement);
        used.add(key);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(input.dimensions).sort());
    for (const dim of Object.values(input.dimensions)) {
      expect(Object.keys(dim).sort()).toEqual(["terms", "values"]);
      distinctText(dim.terms);
      distinctText(dim.values);
    }
    for (const [key, value] of Object.entries(input.session)) {
      expect(input.dimensions[key]?.values, key).toContain(value);
    }
  });

  it("retains the catalog collisions and missing context behind the questions", () => {
    expect(fixtures["AMB-01"].metrics.filter(m => m.state === "released" && m.terms.includes("margin"))).toHaveLength(2);
    expect(fixtures["AMB-04"].metrics.filter(m => m.terms.includes("throughput")).map(m => m.unit).sort())
      .toEqual(["lots/hour", "units/hour"]);
    const regions = fixtures["AMB-06"].dimensions;
    expect(Object.entries(regions).filter(([, d]) => d.terms.includes("region")).map(([key]) => key).sort())
      .toEqual(["bill_region", "ship_region"]);
    for (const [id, missing] of [["AMB-02", "calendar"], ["AMB-03", "baseline_month"],
      ["AMB-07", "shift"], ["AMB-08", "date_range"]]) {
      expect(inputs[id].metrics[0].dimensions[missing]).toBe("required");
      expect(inputs[id].dimensions[missing].values.length).toBeGreaterThan(1);
      expect(inputs[id].session).not.toHaveProperty(missing);
    }
  });

  it("keeps unpublished terms distinct from released metrics and preserves the explicit selections", () => {
    expect(fixtures["AMB-12"].metrics.filter(m => m.terms.includes("ripple index")).map(m => m.state)).toEqual(["candidate"]);
    expect(fixtures["AMB-05"].metrics.map(m => m.terms)).toEqual([["gross energy consumed"]]);
    expect(fixtures["AMB-09"].metrics.map(m => m.unit)).toEqual(["dispatches"]);
    expect(fixtures["AMB-10"].metrics.filter(m => m.state === "released" && m.terms.includes("helpdesk slips"))).toHaveLength(1);
    expect(fixtures["AMB-10"].session).toEqual({ site: "Cedar", month: "2026-07" });
    expect(fixtures["AMB-11"].metrics.filter(m => m.state === "released").map(m => m.ref).sort())
      .toEqual(["billed_distance@2", "traveled_distance@1"]);
    expect(fixtures["AMB-11"].session.month).toBe("2026-06");
  });
});
