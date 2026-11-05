import type { D1Database } from "./d1";
import { getSessionFromRequest } from "./auth-request";
import type { AuthEnv } from "./auth";
import type { AdminStorageEnv } from "./admin-store";
import { canonicalControlJson, isSemanticRelease, isApprovalContract, isEvidenceReceipt } from "./control-objects";

export type ControlKind = "release" | "contract" | "receipt";
const tables = { release: "semantic_releases", contract: "approval_contracts", receipt: "evidence_receipts" } as const;
const guards = { release: isSemanticRelease, contract: isApprovalContract, receipt: isEvidenceReceipt };
export type ControlAccess = { db: D1Database; tenantId: string; principalId: string };

export async function authorizeControlRequest(request: Request, env: AuthEnv & AdminStorageEnv, tenantId: string) {
  const session = await getSessionFromRequest(request, env);
  if (!session) return { ok: false as const, status: 401, code: "unauthenticated" };
  const db = env.ODAP_GATEWAY_DB ?? env.DB;
  if (!db) return { ok: false as const, status: 503, code: "control_storage_unavailable" };
  // Bind membership to the immutable provider identity, not email or a client header.
  const principalId = `${session.provider}:${session.providerId}`;
  const member = await db.prepare("SELECT role FROM control_memberships WHERE tenant_id = ? AND principal_id = ? AND active = 1")
    .bind(tenantId, principalId).first<{ role: string }>();
  if (!member || !["reader", "reviewer", "owner"].includes(member.role)) return { ok: false as const, status: 403, code: "tenant_access_denied" };
  return { ok: true as const, access: { db, tenantId, principalId } };
}

export async function readControlObject(access: ControlAccess, kind: ControlKind, id: string) {
  // Membership is rechecked in the same statement as the object lookup.
  const row = await access.db.prepare(`SELECT o.payload FROM ${tables[kind]} o WHERE o.tenant_id = ? AND o.id = ?
    AND EXISTS (SELECT 1 FROM control_memberships m WHERE m.tenant_id = o.tenant_id AND m.principal_id = ? AND m.active = 1 AND m.role IN ('reader','reviewer','owner'))`)
    .bind(access.tenantId, id, access.principalId).first<{ payload: string }>();
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  if (!guards[kind](value) || value.tenantId !== access.tenantId || value.id !== id) throw new Error("Stored control object is invalid");
  return value;
}

// Internal storage primitive only. It does not certify a release or authorize an action.
// Lifecycle/issuer services must establish those facts before calling this function.
export async function persistControlObject(access: ControlAccess, kind: ControlKind, value: unknown) {
  if (!guards[kind](value) || value.tenantId !== access.tenantId) throw new Error("Invalid tenant control object");
  const payload = canonicalControlJson(value);
  let sql: string;
  let values: string[];
  if (kind === "release") {
    sql = `INSERT INTO semantic_releases(tenant_id,id,payload,created_by) SELECT ?,?,?,?`;
    values = [access.tenantId, value.id, payload, access.principalId];
  } else if (kind === "contract" && isApprovalContract(value)) {
    sql = `INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) SELECT ?,?,?,?,?`;
    values = [access.tenantId, value.id, value.semanticReleaseId, payload, access.principalId];
  } else if (isEvidenceReceipt(value)) {
    const result = await access.db.prepare(`INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM control_memberships WHERE tenant_id = ? AND principal_id = ? AND active = 1 AND role = 'owner')`)
      .bind(access.tenantId, value.id, value.semanticReleaseId, value.contractId, payload, access.principalId, access.tenantId, access.principalId).run();
    if (!result.success || result.meta?.changes !== 1) throw new Error("Control write denied");
    return;
  } else throw new Error("Invalid object kind");
  const result = await access.db.prepare(`${sql} WHERE EXISTS (SELECT 1 FROM control_memberships WHERE tenant_id = ? AND principal_id = ? AND active = 1 AND role = 'owner')`)
    .bind(...values, access.tenantId, access.principalId).run();
  if (!result.success || result.meta?.changes !== 1) throw new Error("Control write denied");
}
