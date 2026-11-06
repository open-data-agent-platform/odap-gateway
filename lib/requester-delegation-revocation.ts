import { delegationHistory, inspectOwnDelegation } from "./delegation-history";
import { validRequestId } from "./review-contract-request";

type Snapshot = NonNullable<ReturnType<typeof delegationHistory>>;
type Result = Awaited<ReturnType<typeof inspectOwnDelegation>> | { state: "revocation_unknown" };

export async function revokeInspectedDelegation(inspected: Snapshot, signal: AbortSignal, send: typeof fetch = fetch): Promise<Result> {
  const before = delegationHistory(inspected, inspected.tenantId, inspected.grantId);
  if (!before || !validRequestId(before.tenantId) || !validRequestId(before.grantId) || before.revokedAt !== null) return { state: "invalid" };
  if (signal.aborted) return { state: "revocation_unknown" };
  try {
    await send("/api/control/" + before.tenantId + "/delegations", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "revoke", delegationId: before.delegationId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
    });
  } catch { /* The write may have committed even if its reply was lost. */ }
  if (signal.aborted) return { state: "revocation_unknown" };
  // Only a durable, matching read is evidence. A concurrent proof may have been added, never removed.
  const read = await inspectOwnDelegation(before, AbortSignal.any([signal, AbortSignal.timeout(15000)]), send);
  if (read.state === "denied" || read.state === "unauthenticated") return read;
  if (read.state === "ready" && read.snapshot.delegationId === before.delegationId && read.snapshot.keyId === before.keyId &&
      read.snapshot.revokedAt !== null && (before.verifiedAt === null || read.snapshot.verifiedAt === before.verifiedAt)) return read;
  return { state: "revocation_unknown" };
}
