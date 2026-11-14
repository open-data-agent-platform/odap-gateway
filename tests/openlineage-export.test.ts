import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { intentJobIdentity } from "../lib/bigquery-job-identity";
import { exportOpenLineage, odapEvidenceSchema, openLineageSchema } from "../lib/openlineage-export";

const fixture = readFileSync("tests/fixtures/settled-job.json", "utf8");
const pin = readFileSync("tests/pins/settled-job.sha256", "utf8").trimEnd();
const scope = { tenantId: "t", intentId: "i" };
const namespace = "https://gateway.example/gateway";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync("tests/fixtures/openlineage-2-0-2.schema.json", "utf8")));
ajv.addSchema(JSON.parse(readFileSync("integrations/openlineage/OdapEvidenceRunFacet.json", "utf8")));
const eventSchema = ajv.getSchema(`${openLineageSchema}#/$defs/RunEvent`)!;
const facetSchema = ajv.getSchema(odapEvidenceSchema)!;

async function changed(change: (data: ReturnType<typeof JSON.parse>) => void) {
  const data = JSON.parse(fixture);
  change(data);
  const json = canonicalControlJson(data);
  return { json, pin: await sha256Text(json) };
}

describe("offline OpenLineage evidence export", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([["succeeded", "COMPLETE"], ["failed", "FAIL"], ["cancelled", "ABORT"]])(
    "exports a complete historical %s cycle with valid schemas", async (outcome, terminal) => {
      vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
      const input = await changed(d => { d.final.outcome = d.observation.outcome = outcome; });
      const events = await exportOpenLineage(input.json, scope, input.pin, namespace);
      expect(events.map(e => e.eventType)).toEqual(["START", terminal]);
      expect(events.map(e => e.eventTime)).toEqual(["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"]);
      for (const event of events) {
        expect(eventSchema(event), JSON.stringify(eventSchema.errors)).toBe(true);
        expect(event).not.toHaveProperty("inputs");
        expect(event).not.toHaveProperty("outputs");
      }
      const facet = events[1].run.facets!.odap_evidence;
      expect(facetSchema(facet), JSON.stringify(facetSchema.errors)).toBe(true);
      expect(facet).toMatchObject({ consistencyChecked: true, issuerAuthenticated: false, retrospective: true,
        evidenceDigest: input.pin, recordedOutcome: outcome });
      expect(events[0].run).not.toHaveProperty("facets");
      expect(fetch).not.toHaveBeenCalled();
    });
  it("has stable UUIDv5 identity matching an independent Python standard-library vector", async () => {
    const first = await exportOpenLineage(fixture, scope, pin, namespace);
    expect(first[0].run.runId).toBe("5dded15c-4047-5160-8b77-73727e0d7944");
    expect(first[1].run.runId).toBe(first[0].run.runId);
    expect(await exportOpenLineage(fixture, scope, pin, namespace)).toEqual(first);
    const adjusted = await changed(d => { d.bill.actualMicroUsd = d.settlement.actualMicroUsd = 4; });
    expect((await exportOpenLineage(adjusted.json, scope, adjusted.pin, namespace))[0].run.runId).toBe(first[0].run.runId);
    expect((await exportOpenLineage(fixture, scope, pin, "https://other.example/gateway"))[0].run.runId).not.toBe(first[0].run.runId);
  });
  it.each(["pending", "unknown", "denied"])("refuses nonterminal or unobserved %s", async outcome => {
    const input = await changed(d => { d.final.outcome = d.observation.outcome = outcome; });
    await expect(exportOpenLineage(input.json, scope, input.pin, namespace)).rejects.toThrow();
  });
  it("refuses inconsistent outcomes and chronology even with a matching pin", async () => {
    for (const change of [
      (d: ReturnType<typeof JSON.parse>) => { d.observation.outcome = "succeeded"; },
      (d: ReturnType<typeof JSON.parse>) => { d.observation.observedAt = d.pending.recordedAt; }
    ]) {
      const input = await changed(change);
      await expect(exportOpenLineage(input.json, scope, input.pin, namespace)).rejects.toThrow();
    }
  });
  it("requires a separate pin and explicit scope", async () => {
    await expect(exportOpenLineage(fixture, scope, "", namespace)).rejects.toThrow("Invalid pin");
    await expect(exportOpenLineage(fixture, scope, "sha256:" + "0".repeat(64), namespace)).rejects.toThrow("checksum mismatch");
    for (const wrong of [{ tenantId: "other", intentId: "i" }, { tenantId: "t", intentId: "other" }, { ...scope, audience: "other" }]) {
      await expect(exportOpenLineage(fixture, wrong, pin, namespace)).rejects.toThrow("scope mismatch");
    }
  });
  it.each(["tenant", "project", "location"])("isolates %s in run identity", async dimension => {
    const original = await exportOpenLineage(fixture, scope, pin, namespace);
    const data = JSON.parse(fixture);
    const newScope = { ...scope };
    if (dimension === "tenant") {
      newScope.tenantId = "another-tenant";
      for (const record of ["release", "contract", "intent", "job", "pending", "observation", "final", "bill", "settlement"])
        data[record].tenantId = newScope.tenantId;
    } else if (dimension === "project") data.job.projectId = "other-project";
    else data.job.location = "EU";
    const identity = await intentJobIdentity({ ...newScope, actionDigest: data.contract.actionDigest,
      projectId: data.job.projectId, location: data.job.location });
    data.job.jobId = identity.jobReference.jobId;
    data.job.actionTag = identity.labels.odap_action;
    data.pending.id = data.job.pendingReceiptId = "pending_" + data.job.jobId;
    data.final.id = data.bill.receiptId = data.settlement.receiptId = "final_" + data.job.jobId;
    const json = canonicalControlJson(data);
    const events = await exportOpenLineage(json, newScope, await sha256Text(json), namespace);
    expect(events[0].run.runId).not.toBe(original[0].run.runId);
    if (dimension === "tenant") expect(events[0].job.name).not.toBe(original[0].job.name);
  });
  it("accepts a bound delegated audience without leaking the delegation claim", async () => {
    const input = await changed(d => {
      d.profile = "odap.gateway.local.settled-delegated-bigquery.v1";
      d.delegation = { admissionAudience: "gateway", claimAudience: "gateway", observedAudience: "gateway", billedAudience: "gateway",
        claimDigest: "sha256:" + "a".repeat(64), observedDigest: "sha256:" + "a".repeat(64), billedDigest: "sha256:" + "a".repeat(64),
        billedProject: d.job.projectId, billedLocation: d.job.location };
    });
    const events = await exportOpenLineage(input.json, { ...scope, audience: "gateway" }, input.pin, namespace);
    expect(facetSchema(events[1].run.facets!.odap_evidence)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("claimDigest");
    await expect(exportOpenLineage(input.json, { ...scope, audience: "other" }, input.pin, namespace)).rejects.toThrow("scope mismatch");
  });
  it.each(["", "relative", "http://example.org/", "https://u:p@example.org/", "https://example.org/?token=x",
    "https://example.org/#x", "https://example.org/?", "https://example.org/\n", "urn:"])("rejects unsafe namespace %j", async value => {
    await expect(exportOpenLineage(fixture, scope, pin, value)).rejects.toThrow();
  });
  it("uses only an explicit allowlist and does not copy free-text reasons or identities", async () => {
    const input = await changed(d => { d.final.reason = "PRIVATE-REASON"; d.bill.reference = "PRIVATE-BILL"; });
    const output = JSON.stringify(await exportOpenLineage(input.json, scope, input.pin, namespace));
    for (const excluded of ["PRIVATE-REASON", "PRIVATE-BILL", "principalId", "agentId", "claimedBy", "observedBy", "actualMicroUsd", "billedBytes", "SELECT "]) {
      expect(output).not.toContain(excluded);
    }
  });
  it("does not allow a schema consumer to upgrade trust or add a sensitive field", async () => {
    const events = await exportOpenLineage(fixture, scope, pin, namespace);
    const facet = events[1].run.facets!.odap_evidence;
    expect(facetSchema({ ...facet, issuerAuthenticated: true })).toBe(false);
    expect(facetSchema({ ...facet, sql: "SELECT 1" })).toBe(false);
  });
});
