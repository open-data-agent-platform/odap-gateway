import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../docs/evaluation/fixtures/approvals.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

const { cases, contracts, actions, releases, scope } = fixture;
function lookup<T>(table: Record<string, T>, key: string): T {
  if (!Object.hasOwn(table, key)) throw new Error("Missing fixture reference: " + key);
  return table[key];
}
const digest = (value: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const control = cases["APR-04"];
const issued = contracts["c-press"];

describe("approval fixture inputs (no admission decisions)", () => {
  it("covers precisely the approval manifest without embedding results", () => {
    const declared = manifest.categories.find(group => group.category === "approvals")!.cases;
    expect(Object.keys(cases).sort()).toEqual(declared.map(c => c.id).sort());
    expect(Object.values(cases).filter(c => c.requests[0].op !== "issue").every(c => c.contract === control.contract)).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/"(?:expected|outcome|assertion|result)"\s*:/i);
  });

  it("reproduces the action and definition pins without using the Gateway compiler", () => {
    for (const r of Object.values(releases)) {
      const { aggregate, column, table } = r.definition;
      expect(r.digest).toBe(digest({ aggregate, column, table }));
    }
    for (const a of Object.values(actions)) {
      const r = lookup(releases, a.release);
      expect(a.digest).toBe(digest({ metricId: r.metric, parameters: { station: a.station },
        profile: "odap.metric-read.v1", target: r.target }));
    }
    for (const c of Object.values(contracts)) {
      expect(c).toMatchObject({ tenant: scope.tenant, principal: scope.principal, agent: scope.agent });
      const action = lookup(actions, c.action);
      if (c.release !== null) expect(c.release).toBe(action.release);
      if (c.state === "issued") expect(c.authorityRef).toBeTruthy();
    }
  });

  it("resolves request and history references at each case's own decision time", () => {
    for (const c of Object.values(cases)) {
      const contract = lookup(contracts, c.contract);
      expect(c.requests.length).toBeGreaterThan(0);
      for (const q of c.requests) {
        if ("action" in q) {
          expect(q.op).toBe("consume");
          expect(q.intent).toBeTruthy();
          expect(Object.values(contracts).map(row => row.reservation)).toContain(q.reservation);
          lookup(actions, q.action);
        } else {
          expect(q.op).toBe(contract.state === "proposed" ? "issue" : "inspect-issued");
        }
      }
      if ("history" in c) {
        expect("issuedAt" in contract).toBe(true);
        const times = c.history.map(event => event.at);
        expect(times).toEqual([...times].sort((a, b) => a - b));
        for (const event of c.history) {
          if ("issuedAt" in contract) expect(event.at).toBeGreaterThan(contract.issuedAt);
          expect(event.at).toBeLessThanOrEqual(c.trustedAt);
          if ("action" in event && typeof event.action === "string") lookup(actions, event.action);
        }
      }
    }
  });

  it("distinguishes missing authority from missing release, revocation and draft-only review changes", () => {
    const unbound = lookup(contracts, cases["APR-01"].contract), unsigned = lookup(contracts, cases["APR-14"].contract);
    expect(unbound).toMatchObject({ state: "proposed", release: null, action: "press-c4", authorityRef: "review:20" });
    expect(unsigned).toMatchObject({ state: "proposed", release: "press-count", authorityRef: null });
    expect(cases["APR-14"].requests[0].definitionDigest).toBe(releases["press-count"].digest);
    expect(cases["APR-02"].history[0].event).toBe("revoked");
    expect(cases["APR-02"].requests).toEqual(control.requests);
    const revision = cases["APR-11"];
    expect(revision.requests[0]).toEqual({ op: "inspect-issued", reference: issued.authorityRef });
    expect(revision.history[0]).toMatchObject({ event: "review-draft", supersedes: issued.authorityRef });
    expect(revision.history[0].action).not.toBe(issued.action);
  });

  it("isolates the exact expiry boundary and an untrusted future timestamp", () => {
    const boundary = cases["APR-07"], forged = cases["APR-08"];
    expect(control.trustedAt).toBeGreaterThan(issued.issuedAt);
    expect(control.trustedAt).toBeLessThan(issued.expiresAt);
    expect(boundary.requests).toEqual(control.requests);
    expect(boundary.trustedAt).toBe(issued.expiresAt);
    expect(forged.trustedAt).toBeGreaterThan(issued.expiresAt);
    expect(forged.requests[0].clientAt).toBeGreaterThan(forged.trustedAt);
    expect(forged.requests[0].claimedExpiry).toBeGreaterThan(forged.requests[0].clientAt);
  });

  it("distinguishes station, aggregate, target and reservation substitutions from the valid request", () => {
    const request = control.requests[0];
    expect(request).toMatchObject({ action: issued.action, reservation: issued.reservation });
    const original = lookup(actions, request.action);
    const filter = lookup(actions, cases["APR-05"].requests[0].action);
    expect(filter).toMatchObject({ release: original.release, station: "C5" });
    expect(original.station).toBe("C4");
    const sum = lookup(actions, cases["APR-06"].requests[0].action);
    const originalRelease = lookup(releases, original.release), sumRelease = lookup(releases, sum.release);
    expect(sumRelease.target).toBe(originalRelease.target);
    expect([originalRelease.definition.aggregate, sumRelease.definition.aggregate]).toEqual(["COUNT_ROWS", "SUM"]);
    const other = cases["APR-13"], secondContract = lookup(contracts, other.otherContract);
    const otherAction = lookup(actions, other.requests[0].action);
    expect(other.contract).toBe(control.contract);
    expect(secondContract.action).toBe(other.requests[0].action);
    expect(otherAction.station).toBe(original.station);
    expect(lookup(releases, otherAction.release).target).not.toBe(originalRelease.target);
    for (const changed of [filter, sum, otherAction]) expect(changed.digest).not.toBe(original.digest);
    expect(cases["APR-09"].requests[0]).toEqual({ ...request, reservation: "res-9" });
    expect(issued.reservation).not.toBe("res-9");
  });

  it("separates concurrent contenders, an exact timeout replay and a new intent after consumption", () => {
    const contenders = cases["APR-03"].requests, replay = cases["APR-10"], spent = cases["APR-12"];
    expect(cases["APR-03"]).not.toHaveProperty("history");
    expect(contenders).toHaveLength(2);
    expect(contenders[0]).toEqual({ ...control.requests[0], group: "g1" });
    expect(contenders[1]).toEqual({ ...contenders[0], intent: "i2" });
    expect(contenders[1].intent).not.toBe(contenders[0].intent);
    expect(scope.budgetUnits).toBeGreaterThanOrEqual(2 * scope.unitsPerIntent);
    expect(replay.history.map(h => h.event)).toEqual(["admitted", "client-timeout"]);
    expect(replay.history[1].intent).toBe(replay.history[0].intent);
    const { intent, action, reservation } = replay.requests[0];
    expect(replay.history[0]).toMatchObject({ intent, action, reservation });
    expect(spent.history[0]).toEqual(replay.history[0]);
    expect(spent.requests[0]).toEqual({ ...replay.requests[0], intent: "i2" });
    expect(spent.requests[0].intent).not.toBe(spent.history[0].intent);
  });
});
