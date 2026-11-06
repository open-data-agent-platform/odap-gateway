import { describe, expect, it } from "vitest";
import fixture from "../docs/evaluation/fixtures/costs.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

const { cases, jobRefs, ledger } = fixture;
type Opening = { limit: number; spent: number; reserved: number };
const free = (s: Opening) => s.limit - s.spent - s.reserved;
type Intent = { reservation: string; held: number; job?: string; terminal?: string };

describe("cost fixture inputs (no ledger execution)", () => {
  it("contains exactly the cost cases with no expected decisions in the inputs", () => {
    const declared = manifest.categories.find(group => group.category === "costs")!.cases;
    expect(Object.keys(cases).sort()).toEqual(declared.map(c => c.id).sort());
    expect(JSON.stringify(fixture)).not.toMatch(/"(?:expected|outcome|assertion|result)"\s*:/i);
    expect(ledger.unit).toBe("micro-USD");
    expect(ledger.initialOverrun).toBe(0);
    const jobs = Object.values(jobRefs);
    for (const job of jobs) expect(job.tenant).toBe(ledger.tenant);
    expect(new Set(jobs.map(j => JSON.stringify([j.tenant, j.project, j.location, j.id]))).size).toBe(jobs.length);
  });

  it.each(Object.entries(cases))("%s opens with balanced, attributable amounts", (_, c) => {
    const intents: Record<string, Intent> = c.intents;
    const held = Object.values(intents);
    for (const value of [...Object.values(c.opening), ...held.map(i => i.held)]) {
      expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    }
    expect(free(c.opening)).toBeGreaterThanOrEqual(0);
    expect(held.reduce((n, i) => n + i.held, 0)).toBe(c.opening.reserved);
    expect(new Set(held.map(i => i.reservation)).size).toBe(held.length);
    for (const i of held) if (i.job) expect(Object.hasOwn(jobRefs, i.job)).toBe(true);
    const posted = "posted" in c ? c.posted : [];
    expect(posted.reduce((n, p) => n + p.bill.amount, 0)).toBe(c.opening.spent);
    for (const p of posted) {
      expect(intents[p.intent]).toMatchObject({ job: p.bill.job, held: 0 });
      expect(p.bill).toMatchObject({ status: "final", unit: ledger.unit, source: "job-invoice" });
    }
    for (const q of c.requests) {
      if ("bill" in q) {
        expect(q.op).toBe("reconcile");
        expect(["succeeded", "cancelled", "failed"]).toContain(intents[q.intent].terminal);
        if (q.bill !== null) {
          expect(q.bill.job).toBe(intents[q.intent].job);
          expect(q.bill.ref.trim()).not.toBe("");
          expect(Number.isSafeInteger(q.bill.amount)).toBe(true);
        }
      } else if ("units" in q) {
        expect(q.op).toBe("reserve");
        expect(Number.isSafeInteger(q.units) && q.units > 0).toBe(true);
      } else {
        expect(q.op).toBe("compute-cap");
        expect(intents[q.intent].job).toBeDefined();
      }
    }
  });

  it("reconciles both possible reservation orders, exact fit and a replay against the opening balance", () => {
    const race = cases["CST-01"], exact = cases["CST-11"], retry = cases["CST-06"];
    const [a, b] = race.requests;
    expect(race.requests).toHaveLength(2);
    expect(a.intent).not.toBe(b.intent);
    expect(a.reservation).not.toBe(b.reservation);
    expect(a.group).toBe(b.group);
    expect([free(race.opening) - a.units, free(race.opening) - b.units]).toEqual([13, 12]);
    expect(a.units + b.units).toBeGreaterThan(free(race.opening));
    expect(free(exact.opening) - exact.requests[0].units).toBe(0);
    expect(retry.requests[0]).toMatchObject({ intent: "i1", reservation: retry.intents.i1.reservation, units: retry.intents.i1.held });
    expect(retry.opening.reserved).toBe(12);
  });

  it("distinguishes a missing bill, an estimate, zero, and a real amount on the same cancelled-job facts", () => {
    const missing = cases["CST-03"], paid = cases["CST-04"], zero = cases["CST-05"], estimate = cases["CST-09"];
    expect(missing.intents.i1).toMatchObject({ terminal: "cancelled", billedBytes: 81 });
    expect(missing.requests[0].bill).toBeNull();
    for (const c of [paid, zero]) {
      expect(c.opening).toEqual(missing.opening);
      expect(c.intents).toEqual(missing.intents);
      expect(c.requests[0].bill).toMatchObject({ status: "final", source: "job-invoice", unit: ledger.unit });
    }
    expect([paid.requests[0].bill.amount, zero.requests[0].bill.amount]).toEqual([3, 0]);
    expect(estimate.requests[0].bill).toMatchObject({ status: "estimate", source: "usage-estimate", amount: 11 });
  });

  it("cross-checks the release of the hold and the over-limit liability without posting the charges", () => {
    const standard = cases["CST-02"], excess = cases["CST-08"];
    const amount = standard.requests[0].bill.amount;
    expect(amount).toBe(17);
    expect(standard.intents.i1.held).toBe(24);
    expect(free(standard.opening) + standard.intents.i1.held - amount).toBe(23);
    const capacity = free(excess.opening) + excess.intents.i1.held;
    expect(capacity).toBe(40);
    expect(excess.requests[0].bill.amount - capacity).toBe(7);
    for (const c of [standard, excess]) {
      expect(c.requests[0].bill).toMatchObject({ status: "final", unit: ledger.unit, source: "job-invoice" });
    }
  });

  it("preserves the invalid currency, negative amount and the expired price as separate inputs", () => {
    expect(cases["CST-07"].requests[0].bill).toMatchObject({ status: "final", unit: "USD", amount: 1 });
    expect(cases["CST-14"].requests[0].bill).toMatchObject({ status: "final", unit: ledger.unit, amount: -2 });
    const { rate, requests: [cap], intents } = cases["CST-10"];
    expect(rate.job).toBe(intents.i1.job);
    expect(rate.revision).toBe(cap.revision);
    expect(rate.microUsdPerTiB).toBeGreaterThan(0);
    expect(rate.maxJobBytes).toBeGreaterThan(0);
    expect(cap.preflightAt).toBeLessThan(rate.validUntil);
    expect(rate.validUntil).toBeLessThan(cap.decisionAt);
  });

  it("distinguishes a posted invoice replay from the same reference claimed for a different job", () => {
    const exact = cases["CST-12"], collision = cases["CST-13"];
    const first = exact.posted[0];
    expect(first.bill.amount).toBe(13);
    expect(exact.requests[0]).toMatchObject(first);
    expect(collision.posted[0]).toEqual(first);
    const reused = collision.requests[0];
    expect(reused.bill).toEqual({ ...first.bill, job: "B" });
    expect(reused.intent).not.toBe(first.intent);
    expect(reused.bill.job).not.toBe(first.bill.job);
  });
});
