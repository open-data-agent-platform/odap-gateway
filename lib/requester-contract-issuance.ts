import { gatewayPath } from "./gateway-path";
import { isApprovalContract, type ApprovalContract } from "./control-objects";
import { delegationHistory, type inspectOwnDelegation } from "./delegation-history";
import { inspectObject } from "./object-inspection";
import { validRequestId } from "./review-contract-request";

export type IssuanceScope = Parameters<typeof inspectOwnDelegation>[0] & { releaseId: string; actionDigest: string };
type Delegation = NonNullable<ReturnType<typeof delegationHistory>>;
type Result = { state: "recorded"; contractId: string; contractState: ApprovalContract["state"] } |
  { state: "ineligible" | "refused" | "unknown" };

export function canRequestIssuance(d: Delegation) {
  return d.verifiedAt !== null && d.revokedAt === null && Date.parse(d.expiresAt) > Date.now();
}

export async function issueForReviewedDelegation(scope: IssuanceScope, inspected: Delegation, signal: AbortSignal,
  send: typeof fetch = fetch): Promise<Result> {
  const { tenantId, grantId, requestId, agentId, expiresAt, releaseId, actionDigest } = scope;
  const d = delegationHistory(inspected, tenantId, grantId);
  if (!d || ![tenantId, grantId, releaseId].every(validRequestId) || !/^sha256:[a-f0-9]{64}$/.test(actionDigest) ||
      d.agentId !== agentId || d.requestId !== requestId || d.expiresAt !== expiresAt || !canRequestIssuance(d)) return { state: "ineligible" };
  if (signal.aborted) return { state: "unknown" };
  try {
    const res = await send(gatewayPath("/api/control/") + tenantId + "/contract-issuances", { method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delegationId: d.delegationId }), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const body = await res.json();
    if (body?.ok === false && ((res.status === 409 && body.code === "contract_issuance_unavailable") ||
      (res.status === 401 && body.code === "unauthenticated") ||
      (res.status === 403 && ["tenant_access_denied", "same_origin_required"].includes(body.code)))) return { state: "refused" };
    const id = body?.issuance?.contractId;
    if (signal.aborted || ![200, 201].includes(res.status) || body?.ok !== true || body.issuance?.delegationId !== d.delegationId ||
        typeof id !== "string" || !validRequestId(id) || res.headers.get("Location") !== gatewayPath("/api/control/") + tenantId + "/contract/" + id)
      return { state: "unknown" };
    // Reconstruct the read path locally. A matching Location alone does not bind this contract to the original proposal.
    const read = await inspectObject(tenantId, id, "contract", AbortSignal.any([signal, AbortSignal.timeout(15000)]), send, c =>
      isApprovalContract(c) && c.id === id && c.tenantId === tenantId && c.authority.mode === "human" && c.authority.reference === grantId &&
      c.agentId === agentId && c.semanticReleaseId === releaseId && c.actionDigest === actionDigest && c.expiresAt === expiresAt ? c.state : null);
    if (read.state === "ready") return { state: "recorded", contractId: id, contractState: read.snapshot };
  } catch { /* An unreadable reply is not a refusal; never repeat the command here. */ }
  return { state: "unknown" };
}
