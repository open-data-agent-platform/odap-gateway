import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixtures from "../docs/evaluation/fixtures/lifecycle.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

type Definition = { table: string; unit: string };
type Revision = { tenant: string; metric: string; state: string; source: string; definition: Definition; deprecatedAt?: number };
type Attempt = { op: string; actor: string; revision?: string; review?: string; receipt?: string;
  contract?: string; source?: string; digest?: string; proposal?: Revision; newRevision?: string; definition?: Definition };
type Input = {
  catalogs: Record<string, string>; actors: Record<string, { tenant: string; role: string; active: boolean }>;
  revisions: Record<string, Revision>; requests: Attempt[];
  reviews?: Record<string, { actor: string; revision: string; decision: string }>;
  receipts?: Record<string, { tenant: string; revision: string; issuedAt: number }>;
  contracts?: Record<string, { tenant: string; revision: string; principal: string }>;
};
const inputs: Record<string, Input> = fixtures;

describe("lifecycle fixture inputs (no registry writes)", () => {
  it("covers exactly the declared lifecycle cases and carries no oracle fields", () => {
    const declared = manifest.categories.find(c => c.category === "lifecycle")!.cases;
    expect(Object.keys(fixtures).sort()).toEqual(declared.map(c => c.id).sort());
    expect(JSON.stringify(fixtures)).not.toMatch(/"(?:expected|outcome|assertion|success|result)"\s*:/i);
  });

  it.each(Object.keys(inputs))("%s has addressable local actors, revisions and request targets", id => {
    const s = inputs[id];
    for (const a of Object.values(s.actors)) {
      expect(Object.hasOwn(s.catalogs, a.tenant)).toBe(true);
      expect(["owner", "reviewer", "agent"]).toContain(a.role);
      expect(typeof a.active).toBe("boolean");
    }
    for (const v of Object.values(s.revisions)) {
      expect(Object.hasOwn(s.catalogs, v.tenant)).toBe(true);
      expect(["candidate", "released", "deprecated"]).toContain(v.state);
      for (const text of [v.metric, v.source, v.definition.table, v.definition.unit]) expect(text.trim()).not.toBe("");
      expect(Number.isInteger(v.deprecatedAt)).toBe(v.state === "deprecated");
    }
    for (const r of Object.values(s.reviews ?? {})) {
      expect(s.actors[r.actor].tenant).toBe(s.revisions[r.revision].tenant);
      expect(["approved", "rejected"]).toContain(r.decision);
    }
    for (const c of Object.values(s.contracts ?? {})) {
      expect(s.revisions[c.revision].tenant).toBe(c.tenant);
      expect(s.actors[c.principal].tenant).toBe(c.tenant);
    }
    for (const e of Object.values(s.receipts ?? {})) {
      expect(s.revisions[e.revision].tenant).toBe(e.tenant);
      expect(Number.isInteger(e.issuedAt)).toBe(true);
    }
    expect(s.requests.length).toBeGreaterThan(0);
    for (const q of s.requests) {
      const actor = s.actors[q.actor];
      expect(actor).toBeDefined();
      expect(["lookup", "promote", "edit", "bind", "verify-receipt", "deprecate", "import"]).toContain(q.op);
      if (q.op === "import") {
        expect(q.newRevision).toBeTruthy();
        expect(Object.hasOwn(s.revisions, q.newRevision!)).toBe(false);
        expect(q.proposal).toMatchObject({ tenant: actor.tenant, state: "candidate", source: s.catalogs[actor.tenant] });
      } else if (q.op === "verify-receipt") {
        expect(s.receipts?.[q.receipt!]?.tenant).toBe(actor.tenant);
      } else {
        const revision = s.revisions[q.revision!];
        expect(revision).toBeDefined();
        // Revisions exist in both tenants in LIF-10; the ownership mismatch is intentional.
        if (id !== "LIF-10") expect(revision.tenant).toBe(actor.tenant);
        if (q.op === "promote") expect(s.reviews?.[q.review!]?.decision).toBe("approved");
        if (q.op === "edit") expect(q.definition).toBeDefined();
        if (q.contract) expect(s.contracts?.[q.contract]).toMatchObject({ revision: q.revision, principal: q.actor });
        if (q.source) expect(q.source).toBe(s.catalogs[revision.tenant]);
        if (q.digest) {
          const { table, unit } = revision.definition;
          expect(q.digest).toBe("sha256:" + createHash("sha256").update(JSON.stringify({ table, unit })).digest("hex"));
        }
      }
    }
  });

  it("distinguishes a stale approval from two concurrent promotions of the same approved revision", () => {
    const stale = fixtures["LIF-03"], concurrent = fixtures["LIF-06"];
    expect(stale.requests[0]).toMatchObject({ revision: "rA", review: "a1" });
    expect(stale.reviews.a1.revision).toBe("rB");
    expect(stale.revisions.rA.definition).not.toEqual(stale.revisions.rB.definition);
    expect(concurrent.requests).toHaveLength(2);
    expect(new Set(concurrent.requests.map(q => q.actor)).size).toBe(2);
    for (const q of concurrent.requests) {
      expect(q).toMatchObject({ op: "promote", review: "a1", revision: concurrent.reviews.a1.revision, concurrentGroup: "g1" });
    }
  });

  it("keeps candidates, rejected reviews and proposed edits separate from published definitions", () => {
    const fresh = fixtures["LIF-01"], rejected = fixtures["LIF-02"], edit = fixtures["LIF-04"];
    expect(fresh.revisions.r1.state).toBe("candidate");
    expect(fresh).not.toHaveProperty("reviews");
    expect(rejected.reviews.d1).toMatchObject({ revision: rejected.requests[0].revision, decision: "rejected" });
    expect(edit.revisions.r1.state).toBe("released");
    expect(edit.requests[0].definition.unit).not.toBe(edit.revisions.r1.definition.unit);
    const later = fixtures["LIF-05"], imported = fixtures["LIF-12"];
    expect(later.requests[0].revision).toBe("r1");
    expect(later.revisions.r2.state).toBe("candidate");
    expect(later.revisions.r2.definition.table).not.toBe(later.revisions.r1.definition.table);
    expect(imported.requests[0].proposal.metric).toBe(imported.revisions.r1.metric);
    expect(imported.requests[0].proposal.definition.table).not.toBe(imported.revisions.r1.definition.table);
  });

  it("preserves the chronology, scope and version differences that make negative controls meaningful", () => {
    const historic = fixtures["LIF-08"], cross = fixtures["LIF-10"], drift = fixtures["LIF-11"];
    expect(historic.receipts.e1.issuedAt).toBeLessThan(historic.revisions.r1.deprecatedAt);
    expect(cross.revisions.reef1.metric).toBe(cross.revisions.clay1.metric);
    expect(cross.actors.jo.tenant).not.toBe(cross.revisions.clay1.tenant);
    expect(cross.requests[0]).toMatchObject({ actor: "jo", revision: "clay1" });
    expect(drift.requests[0].source).not.toBe(drift.revisions.r1.source);
    expect(fixtures["LIF-09"].contracts.c1.revision).toBe("r1");
    expect(fixtures["LIF-09"].revisions.r2.state).toBe("released");
    expect(fixtures["LIF-13"].actors.ari.active).toBe(false);
    expect(fixtures["LIF-07"].requests[0].digest).toMatch(/^sha256:/);
    expect(fixtures["LIF-07"].revisions.r1.state).toBe("deprecated");
    expect(fixtures["LIF-14"].requests[0].digest).toMatch(/^sha256:/);
    expect(fixtures["LIF-14"].requests[0].source).toBe(fixtures["LIF-14"].revisions.r1.source);
  });
});
