import { expect, it, vi } from "vitest";
import { confirmBudgetReservation, inspectBudgetQuote } from "../lib/requester-budget-admission";
import { inspectOwnAdmission } from "../lib/admission-history";

const scope = { tenantId: "t", delegationId: "d", contractId: "c", expiresAt: "2099-01-01T00:00:00.000Z",
  actionDigest: "sha256:" + "a".repeat(64) }, quote = { ...scope, budgetId: "b", microUsd: 80 };
const signal = new AbortController().signal;

it("reads only the original reservation for the inspected contract, delegation and action", async () => {
  const record = { tenantId: scope.tenantId, delegationId: scope.delegationId, contractId: scope.contractId,
    actionDigest: scope.actionDigest, intentId: "intent", budgetId: "b", originalMicroUsd: 80 };
  for (const change of [{ tenantId: "peer" }, { contractId: "other" }, { delegationId: "other" }, { actionDigest: "sha256:"+"b".repeat(64) },
    { originalMicroUsd: 0 }, { originalMicroUsd: 1.1 }, { originalMicroUsd: Number.MAX_SAFE_INTEGER + 1 }, { intentId: "../other" }, { budgetId: " " }]) {
    expect(await inspectOwnAdmission(scope, signal, async () => Response.json({ ok: true, object: { ...record, ...change } })))
      .toEqual({ state: "unavailable" });
  }
  const get = vi.fn(async () => Response.json({ ok: true, object: { ...record, spentUnits: 999, principalId: "not returned" } }));
  expect(await inspectOwnAdmission(scope, signal, get)).toEqual({ state: "ready", snapshot: record });
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith("/api/control/t/contract-admission/c", { method: "GET", cache: "no-store",
    credentials: "same-origin", redirect: "error", signal });
});

it("rejects a foreign quote, a changed action or expiry, and unsafe amounts before confirmation", async () => {
  for (const swap of [{ tenantId: "peer" }, { delegationId: "other" }, { contractId: "other" }, { actionDigest: "sha256:" + "b".repeat(64) },
    { expiresAt: "2099-01-01T00:01:00.000Z" }, { microUsd: 0 }, { microUsd: -1 }, { microUsd: 1.2 },
    { microUsd: Number.MAX_SAFE_INTEGER+1 }, { budgetId: "" }]) {
    const q = { ...quote, ...swap };
    const get: typeof fetch = async () => Response.json({ ok: true, object: q });
    expect(await inspectBudgetQuote(scope, signal, get)).toEqual({ state: "unavailable" });
    const post = vi.fn();
    expect(await confirmBudgetReservation(scope, q, signal, post)).toEqual({ state: "invalid" });
    expect(post).not.toHaveBeenCalled();
  }
});

it("does not retry or expose an intent for an ambiguous reservation", async () => {
  for (const reply of [() => Promise.reject(new Error("lost acknowledgement")),
    () => Promise.resolve(Response.json({ ok: true, admission: { contractId: "other", intentId: "i" } }, { status: 201 })),
    () => Promise.resolve(Response.json({ ok: true, admission: { contractId: "c", intentId: "../x" } }, { status: 201 })),
    () => Promise.resolve(Response.json({ ok: false, code: "unknown_conflict" }, { status: 409 }))]) {
    const post = vi.fn(reply);
    expect(await confirmBudgetReservation(scope, quote, signal, post)).toEqual({ state: "unknown" });
    expect(post).toHaveBeenCalledTimes(1);
  }
});
