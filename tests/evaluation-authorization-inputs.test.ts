import { describe, expect, it } from "vitest";
import fixture from "../docs/evaluation/fixtures/authorization.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";

const { cases, snapshots: { dispatch, evidence } } = fixture;
const control = cases["AUT-15"];
const record = (tenant: string, intent: string) => evidence.resources.find(r => r.tenant === tenant && r.intent === intent);

describe("authorization fixture inputs (no policy evaluation)", () => {
  it("covers exactly the authorization IDs without copying expected outcomes", () => {
    const declared = manifest.categories.find(group => group.category === "authorization")!.cases;
    expect(Object.keys(cases).sort()).toEqual(declared.map(c => c.id).sort());
    expect(JSON.stringify(fixture)).not.toMatch(/"(?:oracle|expected|outcome|assertion|result)"\s*:/i);
  });

  it("resolves every session and scoped request against its own starting snapshot", () => {
    for (const c of Object.values(cases)) {
      const snapshot = c.snapshot === "dispatch" ? dispatch : evidence;
      expect(Object.keys(fixture.snapshots)).toContain(c.snapshot);
      expect(snapshot.memberships.filter(m => m.user === c.session.operator && m.tenant === c.session.tenant)).toHaveLength(1);
      if ("principal" in c.session) {
        expect(c.snapshot).toBe("dispatch");
        expect(dispatch.agents).toContain(c.session.agent);
        expect(dispatch.memberships).toContainEqual({ tenant: c.session.tenant, user: c.session.principal, role: "reader", active: true });
        expect(c.request).toMatchObject({ op: "dispatch", tenant: dispatch.binding.tenant, intent: dispatch.binding.intent });
      } else {
        expect(c.snapshot).toBe("evidence");
        if ("intent" in c.request) expect(record(c.request.tenant, c.request.intent)).toBeDefined();
      }
    }
    expect(evidence.grants).toEqual([]);
    const keys = evidence.resources.map(r => [r.tenant, r.intent].join("/"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("links same-tenant evidence and the inputs for a bounded dispatch", () => {
    const read = cases["AUT-02"];
    expect(read.request).toMatchObject({ op: "export", tenant: read.session.tenant });
    expect(evidence.memberships).toContainEqual({ tenant: read.session.tenant, user: read.session.operator, role: "owner", active: true });
    const r = record(read.request.tenant, read.request.intent)!;
    expect(r).toMatchObject({ pendingReceipt: "p7", finalReceipt: "f7", terminal: "succeeded",
      bill: { receipt: "f7", amount: 17 }, settlement: { receipt: "f7", amount: 17 } });
    expect(dispatch.memberships).toContainEqual({ tenant: control.session.tenant, user: control.session.operator, role: "owner", active: true });
    const scope = { tenant: control.request.tenant, principal: control.session.principal, agent: control.session.agent,
      target: control.request.target, action: control.request.action, policy: dispatch.currentPolicy.revision };
    expect(dispatch.grants).toContainEqual(scope);
    expect(dispatch.contract).toMatchObject({ ...scope, release: dispatch.binding.release, id: dispatch.binding.contract });
    expect(dispatch.binding).toMatchObject({ tenant: scope.tenant, target: scope.target, existingClaims: 0 });
    expect(dispatch.binding.maxBytes).toBeGreaterThan(0);
  });

  it("separates inactive membership, a substituted principal, an ungranted agent and an untrusted identity claim", () => {
    const inactive = cases["AUT-03"], principal = cases["AUT-04"], otherAgent = cases["AUT-06"], spoof = cases["AUT-10"];
    expect(inactive.request).toEqual(control.request);
    expect(dispatch.memberships).toContainEqual({ tenant: inactive.session.tenant, user: inactive.session.operator, role: "owner", active: false });
    expect(principal.session.principal).not.toBe(dispatch.contract.principal);
    expect(dispatch.grants.some(g => g.principal === principal.session.principal && g.agent === principal.session.agent)).toBe(true);
    expect(otherAgent.request).toEqual(control.request);
    expect(dispatch.grants.some(g => g.agent === otherAgent.session.agent)).toBe(false);
    expect(spoof.session).toEqual(otherAgent.session);
    expect(spoof.request).toEqual({ ...otherAgent.request, claimedAgent: dispatch.contract.agent });
    expect(spoof.request.claimedAgent).not.toBe(spoof.session.agent);
  });

  it("changes the project, location, target or action without silently widening the original scope", () => {
    const project = cases["AUT-07"], lookup = cases["AUT-08"].request, target = cases["AUT-09"], write = cases["AUT-13"];
    expect(project.request.project).not.toBe(dispatch.binding.project);
    const bound = record(lookup.tenant, lookup.intent)!;
    expect(lookup.sample).toMatchObject({ project: bound.job.project, id: bound.job.id, status: "DONE",
      jobType: bound.jobType, actionTag: bound.actionTag, maxBytes: bound.maxBytes });
    expect(lookup.sample.location).not.toBe(bound.job.location);
    expect(target.request.target).not.toBe(dispatch.binding.target);
    expect(dispatch.grants.some(g => g.target === target.request.target)).toBe(false);
    expect(write.request.action).toBe("data.update");
    expect(dispatch.contract.action).toBe("data.read");
  });

  it("places membership withdrawal and policy replacement after their respective initial checks", () => {
    const billing = cases["AUT-11"], policy = cases["AUT-12"];
    expect(evidence.memberships).toContainEqual({ tenant: billing.session.tenant, user: billing.session.operator, role: "owner", active: true });
    expect(billing.change).toEqual({ when: "during-invoice-lookup", tenant: billing.session.tenant, user: billing.session.operator, active: false });
    const r = record(billing.request.tenant, billing.request.intent)!;
    expect(r.terminal).toBe("cancelled");
    expect(r.settlement).toBeUndefined();
    expect(billing.request.invoice).toMatchObject({ tenant: r.tenant, job: r.job, status: "final", unit: "micro-USD" });
    expect(policy.request).toEqual(control.request);
    expect(policy.session).toEqual(control.session);
    expect(policy.change).toMatchObject({ when: "before-final-claim", tenant: dispatch.currentPolicy.tenant, target: dispatch.currentPolicy.target });
    expect(policy.change.revision).not.toBe(dispatch.currentPolicy.revision);
  });

  it("retains colliding intent IDs, non-owner access paths and the foreign billing reference", () => {
    const cross = cases["AUT-01"], cancel = cases["AUT-05"], inventory = cases["AUT-14"], bill = cases["AUT-16"];
    expect(cross.request.tenant).not.toBe(cross.session.tenant);
    expect(evidence.memberships.some(m => m.user === cross.session.operator && m.tenant === cross.request.tenant && m.active)).toBe(false);
    expect(record(cross.request.tenant, cross.request.intent)!.finalReceipt)
      .not.toBe(record(cross.session.tenant, cross.request.intent)!.finalReceipt);
    expect(evidence.memberships).toContainEqual({ tenant: cancel.session.tenant, user: cancel.session.operator,
      role: "reader", active: true, duties: ["billing-admin"] });
    expect(record(cancel.request.tenant, cancel.request.intent)!.priorCancellationRequester).toBe("iris");
    expect(inventory.session).toEqual(cancel.session);
    expect(inventory.request).toEqual({ op: "inventory", tenant: inventory.session.tenant });
    expect(bill.request.tenant).toBe(bill.session.tenant);
    const matches = evidence.resources.filter(r => r.bill?.reference === bill.request.reference);
    expect(matches).toHaveLength(1);
    expect(matches[0].tenant).not.toBe(bill.session.tenant);
    expect(evidence.memberships.some(m => m.tenant === matches[0].tenant && m.user === bill.session.operator && m.active)).toBe(false);
  });
});
