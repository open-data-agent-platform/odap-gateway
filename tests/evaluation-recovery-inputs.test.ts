import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bundle from "../docs/evaluation/fixtures/recovery-settled.v1.json";
import fixture from "../docs/evaluation/fixtures/recovery.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

const { scope, records, cases } = fixture;
const pin = readFileSync(new URL("../docs/evaluation/fixtures/recovery-settled.v1.sha256", import.meta.url), "utf8").trimEnd();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function checksum(value: unknown) {
  const text = JSON.stringify(value, (_, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return "sha256:" + sha(text);
}
const record = (key: string) => {
  if (!Object.hasOwn(records, key)) throw new Error("Unknown record: " + key);
  return records[key as keyof typeof records];
};

describe("recovery fixture inputs (no recovery execution)", () => {
  it("matches the declared recovery cases; prior records are inputs, not expected decisions", () => {
    const declared = manifest.categories.find(g => g.category === "recovery")!.cases;
    expect(Object.keys(cases).sort()).toEqual(declared.map(c => c.id).sort());
    expect(JSON.stringify(cases)).not.toMatch(/"(?:expected|outcome|assertion|result)"\s*:/i);
    expect(new Set(scope.owners).size).toBe(scope.owners.length);
  });

  it.each(Object.entries(cases))("%s references ordered, previously stored facts about the same job", (_, c) => {
    expect(c.stored[0]).toBe("bound");
    expect(new Set(c.stored).size).toBe(c.stored.length);
    const events = c.stored.map(record);
    const times = events.map(e => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const end = times[times.length - 1];
    expect(end).toBeLessThan(c.attempt.at);
    for (const e of events) {
      expect(e.job).toBe("kiln");
      if ("actor" in e) expect(scope.owners).toContain(e.actor);
    }
    if ("actor" in c.attempt) expect(scope.owners).toContain(c.attempt.actor);
    if ("snapshotAt" in c) {
      expect(end).toBeLessThanOrEqual(c.snapshotAt);
      expect(c.snapshotAt).toBeLessThan(c.attempt.at);
    }
    if ("sample" in c.attempt) expect(c.attempt.sample.job).toBe(records.bound.job);
    if ("job" in c.attempt) expect(c.attempt.job).toBe(records.bound.job);
    if ("pin" in c.attempt) {
      expect(c.attempt.pin).toBe("retained");
      expect(fixture.retainedPinAt).toBeLessThan(c.attempt.at);
    }
  });

  it("links the original specimen to the job, both receipts, settlement and retained digest", () => {
    const s = { tenantId: scope.tenant, intentId: scope.intent };
    for (const row of [bundle.intent, bundle.job, bundle.pending, bundle.observation, bundle.final, bundle.bill, bundle.settlement]) {
      expect(row).toMatchObject(s);
    }
    const jobId = "odap_" + sha(JSON.stringify(["odap.job.v1", s.tenantId, s.intentId]));
    expect(bundle.job.jobId).toBe(jobId);
    expect(bundle.job.actionTag).toBe(sha(JSON.stringify(["odap.action.v1", jobId, bundle.contract.actionDigest])).slice(0, 48));
    expect(bundle.job.pendingReceiptId).toBe(bundle.pending.id);
    expect(bundle.intent.contractId).toBe(bundle.contract.id);
    expect(bundle.intent.actionDigest).toBe(bundle.contract.actionDigest);
    expect(bundle.contract.semanticReleaseId).toBe(bundle.release.id);
    for (const receipt of [bundle.pending, bundle.final]) {
      expect(receipt).toMatchObject({ contractId: bundle.contract.id, semanticReleaseId: bundle.release.id });
    }
    const tick = (time: string) => (Date.parse(time) - Date.parse("2026-10-10T10:00:00Z")) / 1000;
    expect([bundle.pending.recordedAt, bundle.job.claimedAt, bundle.observation.observedAt, bundle.final.recordedAt].map(tick))
      .toEqual([records.bound.at, records.claim.at, records.cancelled.at, records.settlement.at]);
    expect(bundle.observation).toMatchObject({ outcome: records.cancelled.state, billedBytes: records.cancelled.bytes });
    expect(bundle.final).toMatchObject({ id: "final_" + jobId, outcome: bundle.observation.outcome });
    for (const row of [bundle.bill, bundle.settlement]) expect(row).toMatchObject({ receiptId: bundle.final.id, actualMicroUsd: records.settlement.amount });
    expect(bundle.bill.reference).toBe(records.settlement.invoice);
    expect(checksum(bundle)).toBe(pin);
  });

  it("keeps incomplete restores, scoped verification and the two tampering mechanisms distinct", () => {
    const pre = cases["REC-04"], post = cases["REC-05"], other = cases["REC-06"];
    expect(pre.stored).not.toContain("settlement");
    expect(pre.snapshotAt).toBeLessThan(records.settlement.at);
    expect(post.stored).toContain("settlement");
    expect(post.snapshotAt).toBeGreaterThan(fixture.retainedPinAt);
    expect(fixture.retainedPinAt).toBeGreaterThanOrEqual(records.settlement.at);
    expect(post.attempt).toMatchObject({ tenant: scope.tenant, intent: scope.intent, mode: "read-only" });
    expect(other.attempt.tenant).not.toBe(scope.tenant);
    expect(other.attempt.intent).toBe(scope.intent);
    const link = cases["REC-07"].attempt;
    expect(link).not.toHaveProperty("pin");
    expect(link.edits).toHaveLength(1);
    expect(link.edits[0].path).toBe("final.id");
    expect(link.edits[0].value).not.toBe(bundle.bill.receiptId);
    const [invoice, settlement] = cases["REC-08"].attempt.edits;
    expect([invoice.path, settlement.path]).toEqual(["bill.actualMicroUsd", "settlement.actualMicroUsd"]);
    expect(invoice.value).toBe(settlement.value);
    expect(invoice.value).not.toBe(bundle.bill.actualMicroUsd);
    const copy = structuredClone(bundle);
    copy.bill.actualMicroUsd = invoice.value;
    copy.settlement.actualMicroUsd = settlement.value;
    expect(checksum(copy)).not.toBe(pin);
  });

  it("separates ambiguous submission, nonterminal lookups, enrichment and conflicting outcomes", () => {
    const restart = cases["REC-01"], absent = cases["REC-13"];
    expect(restart.stored).toEqual(["bound", "claim"]);
    expect(restart.attempt.providerAcknowledgement).toBeNull();
    expect(absent.stored).toEqual(restart.stored);
    expect(absent.restartAt).toBeGreaterThan(records.claim.at);
    expect(absent.restartAt).toBeLessThan(absent.attempt.at);
    expect(absent.attempt.httpStatus).toBe(404);
    expect(cases["REC-02"].stored).toEqual(["bound", "claim", "cancel-request"]);
    expect(cases["REC-02"].attempt.sample.state).toBe("RUNNING");
    const enrich = cases["REC-09"], conflict = cases["REC-10"];
    expect(enrich.stored).toContain("cancelled-no-bytes");
    expect(records["cancelled-no-bytes"].bytes).toBeNull();
    expect(enrich.attempt.sample).toMatchObject({ state: "DONE", reason: "stopped", bytes: 29 });
    expect(conflict.attempt.sample).toEqual(enrich.attempt.sample);
    expect(conflict.stored).toContain("failed");
  });

  it("separates stop and cancellation history from uncommitted transaction steps", () => {
    expect(cases["REC-03"].stored).toEqual(["bound", "claim", "succeeded"]);
    expect(cases["REC-11"].stored).toEqual(["bound", "stop"]);
    const retry = cases["REC-14"], original = records["cancel-request"];
    expect(retry.stored).toContain("cancel-request");
    expect(retry.lostResponseAt).toBeGreaterThan(original.at);
    expect(retry.lostResponseAt).toBeLessThan(retry.attempt.at);
    expect(retry.attempt.actor).not.toBe(original.actor);
    const tx = cases["REC-12"];
    expect(tx.stored).toEqual(["bound", "claim", "cancelled"]);
    expect(tx.attempt).toMatchObject({ invoice: bundle.bill.reference, amount: bundle.bill.actualMicroUsd, unit: "micro-USD" });
    expect(tx.attempt.transaction).toEqual([{ step: "insert-final-receipt", storage: "uncommitted" },
      { step: "update-budget", fault: "write-error" }]);
  });
});
