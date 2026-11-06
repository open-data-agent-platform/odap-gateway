import { describe, expect, it } from "vitest";
import manifest from "../docs/evaluation/scenarios.v1.json";
import auth from "../docs/evaluation/fixtures/authorization.v1.json";
import lifecycle from "../docs/evaluation/fixtures/lifecycle.v1.json";
import numbers from "../docs/evaluation/fixtures/numerical.v1.json";
import draft from "../docs/evaluation/review/amendments.draft.json";
import { jobSqlite } from "./fixtures/job-sqlite";

type Scenario = typeof manifest.categories[number]["cases"][number];
const cases = manifest.categories.flatMap<Scenario>(g => g.cases);
const oracle = (id: string) => cases.find(c => c.id === id)!.expected;

describe("author review of fixture discrimination (not Gateway scores)", () => {
  it("separates counting false from counting null without changing the expected count", async () => {
    const original = numbers["NUM-16"].rows;
    const amended = [...original, draft["NUM-16"].appendRow];
    const counts = (rows: typeof original) => jobSqlite(":memory:", "first", `SELECT
      count(*) FILTER (WHERE json_type(value,'$.pass')='false') AS correct,
      count(*) FILTER (WHERE json_type(value,'$.pass')='null') AS faulty FROM json_each(?)`, [JSON.stringify(rows)]);
    expect(oracle("NUM-16")).toEqual({ outcome: "answer", value: 2, unit: "rows" });
    expect(draft["NUM-16"].given).toContain(JSON.stringify(amended.map(r => r.pass)));
    expect(await counts(original)).toEqual({ correct: 2, faulty: 2 });
    expect(await counts(amended)).toEqual({ correct: 2, faulty: 3 });
  });

  it("separates role-only lookup from tenant-scoped lookup using the same active owner and intent ID", () => {
    const { memberships, resources } = auth.snapshots.evidence;
    type Probe = typeof auth.cases["AUT-01"];
    const lookup = ({ session, request }: Pick<Probe, "session" | "request">, bindTenant: boolean) => {
      const member = memberships.find(m => m.tenant === session.tenant && m.user === session.operator);
      if (!member?.active || member.role !== "owner" || (bindTenant && session.tenant !== request.tenant)) return null;
      return resources.find(r => r.tenant === request.tenant && r.intent === request.intent)?.finalReceipt ?? null;
    };
    for (const id of ["AUT-01", "AUT-02"] as const) {
      const probe = auth.cases[id];
      for (const scoped of [true, false]) {
        expect(lookup(probe, scoped) ? "allow" : "deny").toBe(oracle(id).outcome);
      }
    }
    const { session, probes } = draft["AUT-01/02"];
    const receipts = (scoped: boolean) => probes.map(({ request }) => lookup({ session, request }, scoped));
    expect(receipts(true)).toEqual(probes.map(p => p.expectedReceipt));
    expect(receipts(false)).toEqual(["f7", "f9"]);
    expect(receipts(true)).toEqual([null, "f9"]);
  });

  it("rejects zero progress, duplicate releases and unlinked success responses", () => {
    const race = lifecycle["LIF-06"];
    const { revision, review } = race.requests[0];
    const link = { tenant: race.revisions.r1.tenant, revision, review };
    const release = { ...link, id: "new-release" };
    expect(oracle("LIF-06")).toMatchObject({ assertion: "At most one release for that revision and approval." });
    const oldBound = (writes: typeof release[]) => writes.filter(w => w.tenant === link.tenant &&
      w.revision === revision && w.review === review).length <= 1;
    const accepts = (writes: typeof release[], successes: string[]) => writes.length === draft["LIF-06"].newPersistedReleases &&
      writes[0]?.tenant === link.tenant && writes[0]?.revision === revision && writes[0]?.review === review &&
      successes.length > 0 && successes.every(id => id === writes[0].id);
    expect(oldBound([])).toBe(true);
    expect(accepts([], [])).toBe(false);
    expect(accepts([release], [release.id])).toBe(true);
    expect(accepts([release], [release.id, release.id])).toBe(true);
    expect(accepts([release], [])).toBe(false);
    expect(accepts([release], [release.id, "unrelated"])).toBe(false);
    expect(accepts([{ ...release, review: "other" }], [release.id])).toBe(false);
    expect(accepts([release, { ...release, id: "duplicate" }], [release.id])).toBe(false);
  });
});
