import { isApprovalContract, type ApprovalContract } from "./control-objects";
import { inspectObject, type ObjectInspection } from "./object-inspection";

type Snapshot = Pick<ApprovalContract, "id" | "tenantId" | "state" | "semanticReleaseId" | "target" |
  "actionType" | "actionDigest" | "policyRevision" | "sourceRevision" | "expiresAt"> & {
  authorityMode: ApprovalContract["authority"]["mode"]; checkedAt: string; expiredAtLookup: boolean;
};
export type ContractInspection = ObjectInspection<Snapshot>;

export async function inspectApprovalContract(tenant: string, id: string, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<ContractInspection> {
  return inspectObject(tenant, id, "contract", signal, get, value => {
    if (!isApprovalContract(value) || value.tenantId !== tenant || value.id !== id) return null;
    const { tenantId, state, semanticReleaseId, target, actionType, actionDigest, policyRevision, sourceRevision, expiresAt } = value;
    const now = Date.now();
    return { id, tenantId, state, semanticReleaseId, target, actionType, actionDigest,
      policyRevision, sourceRevision, expiresAt, authorityMode: value.authority.mode, checkedAt: new Date(now).toISOString(),
      expiredAtLookup: Date.parse(expiresAt) <= now };
  });
}
